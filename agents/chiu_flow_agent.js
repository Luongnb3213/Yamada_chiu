// Frida agent for Yamada_chiu Gold Membership and store-sale entry flow.
const NUL = ptr(0);

function sym(name) {
  return Module.getGlobalExportByName
    ? Module.getGlobalExportByName(name)
    : Module.getExportByName(null, name);
}

const objc_getClass = new NativeFunction(sym("objc_getClass"), "pointer", ["pointer"]);
const sel_registerName = new NativeFunction(sym("sel_registerName"), "pointer", ["pointer"]);
const msgId = new NativeFunction(sym("objc_msgSend"), "pointer", ["pointer", "pointer"]);
const msgIdx = new NativeFunction(sym("objc_msgSend"), "pointer", ["pointer", "pointer", "uint64"]);
const msgCount = new NativeFunction(sym("objc_msgSend"), "uint64", ["pointer", "pointer"]);
const msgKind = new NativeFunction(sym("objc_msgSend"), "bool", ["pointer", "pointer", "pointer"]);
const msgEval = new NativeFunction(sym("objc_msgSend"), "void", ["pointer", "pointer", "pointer", "pointer"]);
const msg1p = new NativeFunction(sym("objc_msgSend"), "pointer", ["pointer", "pointer", "pointer"]);
const dispatch_async_f = new NativeFunction(sym("dispatch_async_f"), "void", ["pointer", "pointer", "pointer"]);
const mainQ = sym("_dispatch_main_q");
const keepAlive = [];

function onMain(fn) {
  const cb = new NativeCallback(function () {
    try {
      fn();
    } catch (err) {
      send({ err: String(err) });
    }
    const idx = keepAlive.indexOf(cb);
    if (idx >= 0) keepAlive.splice(idx, 1);
  }, "void", ["pointer"]);
  keepAlive.push(cb);
  dispatch_async_f(mainQ, NUL, cb);
}

function SEL(name) {
  return sel_registerName(Memory.allocUtf8String(name));
}

const S_shared = SEL("sharedApplication");
const S_windows = SEL("windows");
const S_subviews = SEL("subviews");
const S_count = SEL("count");
const S_objAt = SEL("objectAtIndex:");
const S_isKind = SEL("isKindOfClass:");
const S_utf8 = SEL("UTF8String");
const S_strWith = SEL("stringWithUTF8String:");
const S_eval = SEL("evaluateJavaScript:completionHandler:");
const S_localizedDescription = SEL("localizedDescription");
const S_description = SEL("description");

const NSString = objc_getClass(Memory.allocUtf8String("NSString"));
const UIApplication = objc_getClass(Memory.allocUtf8String("UIApplication"));
const WKWebView = objc_getClass(Memory.allocUtf8String("WKWebView"));

function nsstr(value) {
  return msg1p(NSString, S_strWith, Memory.allocUtf8String(value));
}

function toStr(ns) {
  if (ns.isNull()) return null;
  const c = msgId(ns, S_utf8);
  return c.isNull() ? null : c.readUtf8String();
}

function windows() {
  const app = msgId(UIApplication, S_shared);
  const arr = msgId(app, S_windows);
  const count = Number(msgCount(arr, S_count));
  const result = [];
  for (let idx = 0; idx < count; idx++) result.push(msgIdx(arr, S_objAt, uint64(idx)));
  return result;
}

function findWK(view, out) {
  if (view.isNull()) return;
  if (msgKind(view, S_isKind, WKWebView)) out.push(view);
  const subviews = msgId(view, S_subviews);
  const count = Number(msgCount(subviews, S_count));
  for (let idx = 0; idx < count; idx++) findWK(msgIdx(subviews, S_objAt, uint64(idx)), out);
}

function allWK() {
  const found = [];
  for (const win of windows()) findWK(win, found);
  return found;
}

function makeBlock(handler) {
  const invoke = new NativeCallback(function (block, result, error) {
    try {
      handler(result, error);
    } catch (err) {
      send({ err: "completion:" + String(err) });
    }
  }, "void", ["pointer", "pointer", "pointer"]);
  const descriptor = Memory.alloc(16);
  descriptor.writeU64(0);
  descriptor.add(8).writeU64(32);
  const block = Memory.alloc(32);
  block.writePointer(sym("_NSConcreteGlobalBlock"));
  block.add(8).writeU32(1 << 28);
  block.add(12).writeU32(0);
  block.add(16).writePointer(invoke);
  block.add(24).writePointer(descriptor);
  keepAlive.push(invoke, block, descriptor);
  return block;
}

function evalInWebView(idx, code) {
  return new Promise(function (resolve) {
    onMain(function () {
      const webviews = allWK();
      if (idx >= webviews.length) {
        resolve(null);
        return;
      }
      const block = makeBlock(function (result) {
        if (result.isNull() && arguments.length > 1 && !arguments[1].isNull()) {
          const desc = toStr(msgId(arguments[1], S_description)) ||
            toStr(msgId(arguments[1], S_localizedDescription)) ||
            "WKWebView evaluateJavaScript error";
          resolve(JSON.stringify({ ok: false, state: "eval_error", error: desc }));
          return;
        }
        resolve(toStr(result));
      });
      msgEval(webviews[idx], S_eval, nsstr(code), block);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseObject(value) {
  if (value == null || value === "") return {};
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function parsePageResult(raw) {
  if (!raw) return { ok: false, state: "no_webview_or_no_result", raw: raw };
  try {
    return JSON.parse(raw);
  } catch (err) {
    return { ok: false, state: "bad_json_result", raw: raw, error: String(err) };
  }
}

function pageProgram(profile, options, mode) {
  const profileJson = JSON.stringify(profile || {});
  const optionsJson = JSON.stringify(options || {});
  const modeJson = JSON.stringify(mode || "step");
  return `
(function () {
  const profileRaw = ${profileJson};
  const options = ${optionsJson};
  const mode = ${modeJson};

  function q(selector, root) {
    return (root || document).querySelector(selector);
  }
  function qa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }
  function text(el) {
    return (el && (el.innerText || el.textContent) || "").replace(/\\s+/g, " ").trim();
  }
  function bodyText() {
    return text(document.body);
  }
  function val() {
    for (let idx = 0; idx < arguments.length; idx++) {
      const key = arguments[idx];
      const value = profileRaw[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
      if (profileRaw.row && profileRaw.row[key] !== undefined && profileRaw.row[key] !== null && String(profileRaw.row[key]).trim() !== "") {
        return String(profileRaw.row[key]).trim();
      }
    }
    return "";
  }
  function setField(selector, value) {
    const el = q(selector);
    if (!el) return false;
    el.focus && el.focus();
    el.value = String(value || "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur && el.blur();
    return true;
  }
  function setSelect(selector, value) {
    const el = q(selector);
    if (!el) return false;
    const rawValue = String(value || "").trim();
    const target = rawValue.replace(/[^0-9]/g, "");
    const normalizedTarget = normalizeTextValue(rawValue);
    let chosen = "";
    for (const opt of Array.prototype.slice.call(el.options || [])) {
      const ov = String(opt.value || "").replace(/[^0-9]/g, "");
      const ot = String(opt.textContent || "").replace(/[^0-9]/g, "");
      const normalizedOption = normalizeTextValue(String(opt.value || "") + " " + String(opt.textContent || ""));
      if (
        opt.value === rawValue ||
        (target && (ov === target || ot === target)) ||
        (normalizedTarget && normalizedOption.indexOf(normalizedTarget) >= 0)
      ) {
        chosen = opt.value;
        break;
      }
    }
    if (!chosen) return false;
    el.value = chosen;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  function setChecked(selector, checked) {
    const el = q(selector);
    if (!el) return false;
    el.checked = !!checked;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  function clickElement(el) {
    if (!el) return false;
    if (options.submit === false || options.dryRun) return true;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }
  function tapElement(el) {
    if (!el) return false;
    if (options.submit === false || options.dryRun) return true;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
    const x = Math.round(rect.left + Math.max(1, rect.width) / 2);
    const y = Math.round(rect.top + Math.max(1, rect.height) / 2);
    const mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    try {
      if (typeof PointerEvent === "function") {
        el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ pointerId: 1, pointerType: "touch", isPrimary: true }, mouseOpts)));
        el.dispatchEvent(new PointerEvent("pointerup", Object.assign({ pointerId: 1, pointerType: "touch", isPrimary: true }, mouseOpts)));
      }
    } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("mousedown", mouseOpts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("mouseup", mouseOpts)); } catch (e) {}
    if (typeof el.click === "function") {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent("click", mouseOpts));
    }
    return true;
  }
  function navigateElement(el) {
    if (!el) return false;
    const href = String(el.getAttribute && el.getAttribute("href") || el.href || "").trim();
    if (href && !/^javascript:/i.test(href) && href !== "#") {
      if (options.submit === false || options.dryRun) return true;
      location.href = el.href || href;
      return true;
    }
    return clickElement(el);
  }
  function clickText(pattern, selector) {
    const els = qa(selector || "a,button,input[type=button],input[type=submit]");
    for (const el of els) {
      const value = String(el.value || "") || text(el);
      if (pattern.test(value)) return clickElement(el);
    }
    return false;
  }
  function submitForm(form) {
    if (!form) return false;
    if (options.submit === false || options.dryRun) return true;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
    return true;
  }
  function submitCreditPaymentForm() {
    const form = document.creditFepChargePaymentInfoEntryActionForm || q('form[name="creditFepChargePaymentInfoEntryActionForm"]') || q("form");
    if (!form) return false;
    if (options.submit === false || options.dryRun) return true;
    if (typeof window.check === "function" && !window.check()) return false;
    const link = qa("a").find(function (el) { return /^次へ$/.test(text(el)); });
    const onclick = String(link && link.getAttribute("onclick") || "");
    const actionMatch = onclick.match(/doSubmit\\([^,]+,\\s*['"]([^'"]+)['"]/);
    const action = actionMatch ? actionMatch[1] : (form.getAttribute("action") || form.action || "");
    if (typeof window.doSubmit === "function" && action) {
      const beforeUrl = location.href;
      window.doSubmit(form, action);
      if (link) {
        window.setTimeout(function () {
          const stillOnCreditForm = location.href === beforeUrl && !!q('form[name="creditFepChargePaymentInfoEntryActionForm"]');
          if (stillOnCreditForm) tapElement(link);
        }, Number(options.creditSubmitFallbackDelayMs || 1200));
      }
      return true;
    }
    if (link && tapElement(link)) return true;
    if (action) form.setAttribute("action", action);
    return submitForm(form);
  }
  function creditPageReady() {
    // Màn gold-credit-card-payment hay bị treo khi agent bấm 次へ trước lúc trang
    // tải xong: lúc đó common.js (hàm doSubmit) chưa có và ảnh thẻ chưa render.
    // readyState === "complete" chính là mốc window.load -> toàn bộ ảnh đã xong,
    // nên chờ tới đó rồi mới submit thì click ăn ngay (đúng quan sát thực tế).
    // __chiuCreditFirstSeen sống qua các lần inject vì cùng một page/window, và
    // tự reset khi trang điều hướng đi. Fallback theo thời gian để không kẹt vĩnh
    // viễn nếu một ảnh treo mạng (readyState mãi không "complete").
    var now = Date.now();
    var first = now;
    try {
      if (!window.__chiuCreditFirstSeen) window.__chiuCreditFirstSeen = now;
      first = window.__chiuCreditFirstSeen;
    } catch (e) {}
    var maxWaitMs = Number(options.creditReadyMaxWaitMs);
    if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) maxWaitMs = 20000;
    if (now - first >= maxWaitMs) return true;
    if (typeof window.doSubmit !== "function") return false;
    return document.readyState === "complete";
  }
  function flowCompleteDelayMs() {
    const n = Number(options.flowCompleteDelayMs);
    if (Number.isFinite(n) && n >= 0) return n;
    return 2000;
  }
  function isCardRetryEnabled() {
    return /^(1|true|yes|on)$/i.test(val("card_retry_enabled", "cardRetryEnabled"));
  }
  function cardRetryStorageKey() {
    return [
      "chiuCardRetrySubmitted",
      val("email") || "-",
      val("card_retry_attempt", "cardRetryAttempt") || "retry",
      val("credit_card_number", "card_number").replace(/[^0-9]/g, "").slice(-4) || "card"
    ].join(":");
  }
  function cardRetryAlreadySubmitted() {
    try { return sessionStorage.getItem(cardRetryStorageKey()) === "1"; } catch (e) { return false; }
  }
  function markCardRetrySubmitted() {
    try { sessionStorage.setItem(cardRetryStorageKey(), "1"); } catch (e) {}
  }
  function delayBeforeFlowComplete() {
    if (options.submit === false || options.dryRun) return;
    const ms = flowCompleteDelayMs();
    if (!ms) return;
    const until = Date.now() + ms;
    while (Date.now() < until) {}
  }
  function clickSubmitValue(value) {
    const target = qa('input[type="submit"],button[type="submit"],input[type="button"],button').find(function (el) {
      return String(el.value || text(el)).trim() === value;
    });
    return clickElement(target);
  }
  function result(state, action, extra) {
    return Object.assign({
      ok: true,
      state: state,
      action: action || "",
      title: document.title || "",
      url: location.href,
      readyState: document.readyState,
      bodyText: bodyText().slice(0, 500)
    }, extra || {});
  }
  function fail(state, action, extra) {
    return result(state, action, Object.assign({ ok: false }, extra || {}));
  }
  function parseCardExp(raw) {
    const compact = String(raw || "").trim();
    let m = compact.match(/^(\\d{1,2})\\s*[\\/-]\\s*(\\d{2,4})$/);
    if (!m) m = compact.replace(/[^0-9]/g, "").match(/^(\\d{2})(\\d{2,4})$/);
    if (!m) return { month: val("credit_card_month", "card_month"), year: val("credit_card_year", "card_year") };
    let year = m[2];
    if (year.length === 2) year = "20" + year;
    return { month: m[1].padStart(2, "0"), year: year };
  }
  function detectGoldRegistered() {
    return goldRegisteredEvidence().length > 0;
  }
  function goldRegisteredEvidence() {
    const b = bodyText();
    const registeredLabels = ["ゴールド会員注意事項", "来店スロット", "記念日設定", "クレジットカード情報変更手続き", "解約方法"];
    return registeredLabels.filter(function (label) { return b.indexOf(label) >= 0; });
  }
  function normalizeTextValue(value) {
    try {
      return String(value || "").normalize("NFKC").replace(/\\s+/g, "").trim();
    } catch (err) {
      return String(value || "").replace(/\\s+/g, "").trim();
    }
  }
  function hashString(value) {
    const textValue = String(value || "");
    let hash = 2166136261;
    for (let idx = 0; idx < textValue.length; idx++) {
      hash ^= textValue.charCodeAt(idx);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
  const ONEPIECE_STORE_CHOICES = [
    { pre: "13", area: "品川区", shopNo: "468", shopName: "LABI LIFE SELECT 品川大井町" },
    { pre: "13", area: "目黒区", shopNo: "230", shopName: "LABI自由が丘" },
    { pre: "13", area: "豊島区", shopNo: "7", shopName: "LABI池袋本店" },
    { pre: "13", area: "新宿区", shopNo: "1100", shopName: "LABI新宿西口館" },
    { pre: "13", area: "渋谷区", shopNo: "1020", shopName: "LABI渋谷" }
  ];
  function preferredOnepieceStore() {
    const wantedName = normalizeTextValue(val("onepiece_shop_name", "lottery_shop_name", "shop_name"));
    if (wantedName) {
      const byName = ONEPIECE_STORE_CHOICES.find(function (item) {
        return normalizeTextValue(item.shopName).indexOf(wantedName) >= 0 || wantedName.indexOf(normalizeTextValue(item.shopName)) >= 0;
      });
      if (byName) return byName;
    }
    const wantedArea = normalizeTextValue(val("onepiece_area", "lottery_area"));
    if (wantedArea) {
      const inArea = ONEPIECE_STORE_CHOICES.filter(function (item) { return normalizeTextValue(item.area) === wantedArea; });
      if (inArea.length) return inArea[hashString(val("email")) % inArea.length];
    }
    return ONEPIECE_STORE_CHOICES[hashString(val("email")) % ONEPIECE_STORE_CHOICES.length];
  }
  function onepieceBannerLink() {
    return q('#category009 a[href*="1005_lottery-pcs/notice.html"]') ||
      (q('#banner_impression-banner_topics_0000008500') && q('#banner_impression-banner_topics_0000008500').closest("a")) ||
      qa('a').find(function (el) { return /ONE PIECE|ワンピース|抽選販売/.test(text(el) + " " + String(el.href || "")); });
  }
  function selectHasValue(select, value) {
    return qa("option", select).some(function (option) { return String(option.value) === String(value); });
  }
  function findShopRadio(store) {
    const wantedName = normalizeTextValue(store.shopName);
    const labels = qa("#container label, label.shopLabels, label#shopLabels");
    const byLabel = labels.find(function (label) {
      return normalizeTextValue(text(label)).indexOf(wantedName) >= 0;
    });
    if (byLabel) {
      const radio = q('input[type="radio"]', byLabel);
      if (radio) return { radio: radio, label: text(byLabel) };
    }
    const byValue = q('#container input[type="radio"][value="' + store.shopNo + '"]') ||
      q('input[type="radio"][value="' + store.shopNo + '"]');
    if (byValue) return { radio: byValue, label: text(byValue.closest("label") || byValue) };
    return null;
  }
  function selectOnepieceStore(store) {
    if (!setSelect("#pre", store.pre)) return { ok: false, missing: "prefecture" };
    const areaSelect = q("#area");
    if (!areaSelect) return { ok: false, missing: "area_select" };
    if (!selectHasValue(areaSelect, store.area)) {
      return { ok: false, wait: true, missing: "area_option", expectedArea: store.area };
    }
    if (String(areaSelect.value) !== String(store.area) && !setSelect("#area", store.area)) {
      return { ok: false, wait: true, missing: "area_select_value", expectedArea: store.area };
    }
    const found = findShopRadio(store);
    if (!found) return { ok: false, wait: true, missing: "shop_radio", expectedShop: store.shopName };
    const radio = found.radio;
    radio.checked = true;
    radio.dispatchEvent(new Event("input", { bubbles: true }));
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    setField("#selected_shop_no", radio.value || store.shopNo);
    return { ok: true, store: store, selectedShopNo: radio.value || store.shopNo, selectedShopLabel: found.label };
  }
  function fillOnepieceForm() {
    const wantedItem = val("lottery_item_name") || "ストームエメラルダ";
    const product = qa('input[type="radio"][name="items[]"]').find(function (el) {
      return text(el.closest("label") || el).indexOf(wantedItem) >= 0;
    });
    if (!product) return { ok: false, missing: "lottery_item", wantedItem: wantedItem };
    product.checked = true;
    product.dispatchEvent(new Event("change", { bubbles: true }));
    const productName = text(product.closest("label") || product).replace(/\\s*税込.*$/, "").trim();
    const store = preferredOnepieceStore();
    const selected = selectOnepieceStore(store);
    if (selected.wait) return selected;
    if (!selected.ok) return selected;
    if (!String((q('#selected_campaign') || {}).value || "")) setField('#selected_campaign', productName);
    setChecked('input[name="check_privacy"]', true);
    const btn = q("button#entry") ||
      qa('button,input[type="submit"],input[type="button"]').find(function (el) {
        return /応募内容の確認へ進む/.test(String(el.value || "") + text(el));
      });
    if (!btn) return { ok: false, missing: "entry_button", store: store };
    if (options.submit === false || options.dryRun) {
      return { ok: true, dryRun: true, store: store, selectedShopNo: selected.selectedShopNo, selectedShopLabel: selected.selectedShopLabel };
    }
    clickElement(btn);
    return { ok: true, store: store, selectedShopNo: selected.selectedShopNo, selectedShopLabel: selected.selectedShopLabel };
  }
  function normalizeDigits(value) {
    return String(value || "").replace(/[^0-9]/g, "");
  }
  function normalizeDob(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const compact = raw.replace(/[^0-9]/g, "");
    if (compact.length === 8) return compact;
    const parts = raw.match(/^(\\d{1,4})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{1,4})$/);
    if (!parts) return compact;
    let y = parts[1], m = parts[2], d = parts[3];
    if (y.length !== 4 && d.length === 4) { const tmp = y; y = d; d = tmp; }
    return y.padStart(4, "0") + m.padStart(2, "0") + d.padStart(2, "0");
  }
  function normalizeGender(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    if (["1", "m", "male", "man", "nam"].indexOf(raw) >= 0 || raw.indexOf("男") >= 0) return "1";
    if (["2", "f", "female", "woman", "nu", "nữ"].indexOf(raw) >= 0 || raw.indexOf("女") >= 0) return "2";
    return raw;
  }
  function setPrefecture(value) {
    const select = q('select[name="prefcode"]');
    if (!select) return false;
    const target = String(value || "").trim();
    if (!target) return false;
    let selected = null;
    for (const option of Array.prototype.slice.call(select.options || [])) {
      const optText = text(option);
      if (option.value === target || optText === target || optText.indexOf(target) >= 0 || target.indexOf(optText) >= 0) {
        selected = option;
        break;
      }
    }
    if (!selected) return false;
    select.value = selected.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  function requireFields(fields) {
    return fields.filter(function (item) { return !item.value; }).map(function (item) { return item.name; });
  }
  // Registration screens (reg001 -> reg006). Each def must match ALL of its
  // required selectors plus at least one hint per provided url/title/body group,
  // so reg screens are never confused with the parallel login (changephone/chgauth)
  // screens or with the logged-in home/gold/onepiece screens.
  const REGISTER_SCREEN_DEFS = [
    { state: "tracking_location_consent", urlIncludes: ["profilepassport.jp"], titleIncludes: ["個別情報開示"], requiredSelectors: [".btn-close"] },
    { state: "member_register_top", urlIncludes: ["action=authorize2"], titleIncludes: ["会員登録"], requiredSelectors: ['a[href*="module=memberlogin"][href*="action=reg001"]'], absentSelectors: ["#chkbox"] },
    { state: "terms_consent", urlIncludes: ["action=reg001"], titleIncludes: ["新規登録"], requiredSelectors: ["#chkbox", 'form[name="input01"][action*="func=regist"]'] },
    { state: "email_register_input", urlIncludes: ["func=regist"], titleIncludes: ["メールアドレス登録"], requiredSelectors: ['input[name="reg_mail_address"]', 'input[name="mail_address_check"]'] },
    { state: "email_register_confirm", urlIncludes: ["action=reg002", "func=confirm"], bodyIncludes: ["認証コードをお送りします"], requiredSelectors: ['form[action*="action=regauth"] input[name="token"]'], absentSelectors: ['input[name="inputcode"]'] },
    { state: "unexpected_error_restart", bodyIncludes: ["予期せぬエラー", "最初からやり直してください"], requiredSelectors: ['a[href*="module=authorize"][href*="action=authorize2"]'] },
    { state: "email_auth_code_input", urlIncludes: ["action=regauth"], titleIncludes: ["メールアドレス登録"], requiredSelectors: ['input[name="inputcode"]'] },
    { state: "member_info_input", urlIncludes: ["action=reg003"], requiredSelectors: ['form[name="input01"] input[name="password"]', 'input[name="tel"]', 'input[name="sei"]', 'input[name="mei"]', 'input[name="zip"]', 'select[name="prefcode"]'] },
    { state: "member_info_confirm", urlIncludes: ["action=reg005"], bodyIncludes: ["上記で登録する"], requiredSelectors: ['form[name="inputreg"]'] },
    { state: "member_register_complete", urlIncludes: ["action=reg006"], titleIncludes: ["会員登録完了"], requiredSelectors: ['a[href="ymd://"]'] }
  ];
  function registerScreen() {
    const url = location.href || "";
    const titleValue = document.title || "";
    const bodyValue = bodyText();
    for (const def of REGISTER_SCREEN_DEFS) {
      const required = def.requiredSelectors || [];
      if (!required.length) continue;
      if (!required.every(function (sel) { return !!q(sel); })) continue;
      const absent = def.absentSelectors || [];
      if (!absent.every(function (sel) { return !q(sel); })) continue;
      if ((def.urlIncludes || []).length && !def.urlIncludes.some(function (h) { return url.indexOf(h) >= 0; })) continue;
      if ((def.titleIncludes || []).length && !def.titleIncludes.some(function (h) { return titleValue.indexOf(h) >= 0; })) continue;
      if ((def.bodyIncludes || []).length && !def.bodyIncludes.some(function (h) { return bodyValue.indexOf(h) >= 0; })) continue;
      return def.state;
    }
    return "";
  }
  function registrationActive() {
    // Luồng đăng ký chỉ bật khi checkbox "luồng mới" được tick (options.registerEnabled).
    // Không tick -> luôn false -> giữ nguyên luồng cũ (login/gold/onepiece), kể cả khi
    // reg_status trống. Khi đã tick thì vẫn tôn trọng reg_status=SUCCESS để chỉ đăng nhập.
    if (!options || !options.registerEnabled) return false;
    return String(val("reg_status", "regStatus") || "").toUpperCase() !== "SUCCESS";
  }
  function currentScreen() {
    const b = bodyText();
    const title = document.title || "";
    const href = location.href || "";
    const cardUnusable = /お取扱出来ないクレジットカード|入力された内容にエラーがあります/.test(b) && /クレジット/.test(b);
    const canRetryCardOnThisPage = isCardRetryEnabled() && !cardRetryAlreadySubmitted() && q('input[name="ccNumber"]') && q('select[name="ccExpirationMonth"]');
    if (/会員でないか、システムエラーのため表示できません/.test(b)) return "ymd_common_error_no_retry";
    if (
      href.indexOf("profilepassport.jp") >= 0 &&
      (/個別情報開示/.test(title) || /トラッキングの許可|位置情報等のデータの利用/.test(b) || q(".btn-close"))
    ) return "tracking_location_consent";
    if (registrationActive()) {
      const regState = registerScreen();
      if (regState) return regState;
    }
    // Logged-out container left on the register flow: back out to the top page so we can log in.
    if (/action=reg001/.test(href) && q('input[name="reg_mail_address"]') && q('a[href*="module=cancel"][href*="action=can001"]')) return "register_email_input_logged_out";
    if (/module=cancel/.test(href) && /action=can001/.test(href) && q('form[action*="action=can003"] button[type="submit"]')) return "register_cancel_confirm";
    if ((href.indexOf("_lottery-pcs/notice.html") >= 0 || /ONE PIECE|抽選販売/.test(title + " " + b)) && q("#go-form-btn")) return "onepiece_lottery_notice";
    if (/すでにお申込み済み|申込済み|お申込み済み/.test(b) && /lotterysale001/.test(href)) return "onepiece_lottery_already_applied";
    if (q('form[action*="lotterysale001"]') && q("#pre") && q("#area") && q("#entry")) return "onepiece_lottery_apply_form";
    if (/応募確認/.test(title + " " + b) && /応募を確定する/.test(b) && q('form[action*="lotterysale002"]')) return "onepiece_lottery_apply_confirm";
    if (/lotterysale003/.test(href) || /応募完了|応募を受け付けました|ご応募ありがとうございました/.test(title + " " + b)) return "onepiece_lottery_complete";
    if (cardUnusable && !canRetryCardOnThisPage) return "gold_card_unusable";
    if (q('input[name="login_address"]') && q('input[name="login_address_check"]')) return "login_email_input";
    if (q('input[name="inputcode"]') && /認証コード/.test(b) && /ログイン|メール/.test(b)) return "login_auth_code_input";
    if (/changephone/.test(href) && /action=chgauth/.test(href) && /ご指定のメールアドレスは正常に認証できませんでした/.test(b)) return "login_email_auth_failed_no_retry";
    if (/changephone/.test(href) && /action=chgauth/.test(href) && /メールに記載されたURLをご確認ください/.test(b) && !q('input[name="inputcode"]')) return "login_email_url_required";
    if (/changephone/.test(href) && /action=chg003/.test(href) && /ヘルプ/.test(title + " " + b) && /お問合せ|お問い合わせ/.test(b)) return "login_help_redirect_no_retry";
    if (/メールアドレス、暗証番号、電話番号に誤りがあります/.test(b)) return "login_identity_mismatch_no_retry";
    if (/changephone/.test(href) && /action=chg003/.test(href) && q('input[name="mail_address"]') && q('input[name="password"]') && q('input[name="tel"]')) return "login_link_identity_input";
    if (/下記メールアドレス|送信/.test(b) && /changephone|chgauth/.test(href + " " + document.documentElement.innerHTML) && !q('input[name="inputcode"]')) return "login_email_confirm";
    if (/ログイン完了/.test(title + " " + b)) return "login_complete";
    if (/会員登録/.test(title + " " + b) && /ログイン/.test(b) && q('a[href*="changephone"][href*="chg001"], a.but2')) return "member_register_top_logged_out";
    if (q('input[name="ccNumber"]') && q('select[name="ccExpirationMonth"]')) return "gold_credit_card_payment";
    if (/ご購入内容の確認/.test(b) && /購入/.test(b)) return "gold_payment_confirm";
    if (/ご購入処理の完了/.test(b) || /ご購入は正常に完了しました/.test(b)) return "gold_payment_complete";
    if (/支払い方法選択/.test(b) && /クレジットカード/.test(b)) return "gold_payment_select";
    if ((q('#terms') || q('#toggleButton')) && /ゴールド会員/.test(b) && /申し込む/.test(b)) return "gold_membership_benefits";
    if (/ヤマダゴールド会員サービス/.test(b) || /ヤマダデンキ - マイページ/.test(title)) return detectGoldRegistered() ? "mypage_gold_registered" : "mypage_gold_not_registered";
    if ((q('a[data-id="category009"]') || /店頭セール/.test(b)) && /マイページ/.test(b)) return "home";
    if (href === "about:blank" || !b) return "loading";
    return "unknown";
  }
  function goHome() {
    if (options.submit === false || options.dryRun) return true;
    location.href = "index.php?module=authorize&action=authorize2";
    return true;
  }
  function clickStoreSale() {
    const el = q('a[data-id="category009"]') || qa('a,button').find(function (node) { return text(node).indexOf("店頭セール") >= 0; });
    return clickElement(el);
  }

  const state = currentScreen();
  if (mode === "detect" || mode === "screen") return JSON.stringify(result(state, "screen", {
    goldRegistered: detectGoldRegistered(),
    goldEvidence: goldRegisteredEvidence(),
    email: val("email")
  }));

  switch (state) {
    case "register_email_input_logged_out": {
      navigateElement(q('a[href*="module=cancel"][href*="action=can001"]'));
      return JSON.stringify(result(state, "back_to_first_screen"));
    }
    case "register_cancel_confirm": {
      if (options.submit !== false && !options.dryRun) clickElement(q('form[action*="action=can003"] button[type="submit"]'));
      return JSON.stringify(result(state, "confirm_back_to_first_screen"));
    }
    case "member_register_top_logged_out": {
      const link = q('a[href*="changephone"][href*="chg001"]') || qa('a').find(function (el) { return text(el).indexOf("ログイン") >= 0; });
      if (!link) return JSON.stringify(fail(state, "missing_login_link"));
      navigateElement(link);
      return JSON.stringify(result(state, "open_login"));
    }
    case "login_email_input": {
      const email = val("email");
      if (!email) return JSON.stringify(fail(state, "missing_email"));
      setField('input[name="login_address"]', email);
      setField('input[name="login_address_check"]', email);
      clickSubmitValue("次へ") || submitForm(q("form"));
      return JSON.stringify(result(state, "fill_login_email_and_submit", { email: email }));
    }
    case "login_email_confirm": {
      clickSubmitValue("送信") || submitForm(q("form"));
      return JSON.stringify(result(state, "send_login_auth_email"));
    }
    case "login_email_url_required": {
      const loginUrl = val("login_url", "loginUrl");
      if (!loginUrl) return JSON.stringify(fail(state, "need_login_url", { needs_login_url: true }));
      if (options.submit !== false && !options.dryRun) location.href = loginUrl;
      return JSON.stringify(result(state, "open_login_url_from_email"));
    }
    case "login_link_identity_input": {
      const email = val("email");
      const pin = normalizeDigits(val("pin", "password"));
      const phone = normalizeDigits(val("phone", "tel"));
      const missing = requireFields([
        { name: "email", value: email },
        { name: "pin", value: pin },
        { name: "phone", value: phone }
      ]);
      if (missing.length) return JSON.stringify(result("login_identity_missing_no_retry", "fail_no_retry", { noRetry: true, reason: "missing_login_identity_data", missing: missing }));
      setChecked('input[name="register"][value="mail_address"]', true);
      setField('input[name="mail_address"]', email);
      setField('input[name="password"]', pin);
      setField('input[name="tel"]', phone);
      clickSubmitValue("OK") || submitForm(q('form[action*="action=chg003"]') || q("form"));
      return JSON.stringify(result(state, "fill_login_identity_and_submit", { email: email }));
    }
    case "login_identity_mismatch_no_retry":
      return JSON.stringify(result(state, "fail_no_retry", {
        noRetry: true,
        reason: "login_identity_mismatch"
      }));
    case "login_help_redirect_no_retry":
      return JSON.stringify(result(state, "fail_no_retry", {
        noRetry: true,
        reason: "login_help_redirect"
      }));
    case "login_email_auth_failed_no_retry":
      return JSON.stringify(result(state, "fail_no_retry", {
        noRetry: true,
        reason: "login_email_auth_failed"
      }));
    case "login_auth_code_input": {
      const code = val("auth_code");
      if (!code) return JSON.stringify(fail(state, "need_login_otp", { needs_otp: true }));
      setField('input[name="inputcode"]', code);
      clickSubmitValue("次へ") || submitForm(q("form"));
      return JSON.stringify(result(state, "fill_login_otp_and_submit"));
    }
    case "login_complete": {
      clickSubmitValue("アプリトップへ") || clickText(/アプリトップへ/);
      return JSON.stringify(result(state, "open_app_top_after_login"));
    }
    case "home": {
      const goldStatus = String(val("gold_status") || "").toUpperCase();
      const goldDone = goldStatus === "SUCCESS" || sessionStorage.getItem("chiuGoldDone") === "1" || window.name === "chiuGoldDone";
      if (goldDone) {
        const banner = onepieceBannerLink();
        if (banner) {
          navigateElement(banner);
          return JSON.stringify(result(state, "open_onepiece_lottery_notice", { goldStatus: goldStatus, goldDone: true }));
        }
        clickStoreSale();
        return JSON.stringify(result("store_sale_tab", "open_store_sale_tab", { goldStatus: goldStatus, goldDone: true }));
      }
      const link = q('a[href*="module=mypage"][href*="action=mp001"]') || qa('a').find(function (el) { return text(el).indexOf("マイページ") >= 0; });
      if (!link) return JSON.stringify(fail(state, "missing_mypage_link"));
      navigateElement(link);
      return JSON.stringify(result(state, "open_mypage"));
    }
    case "mypage_gold_registered": {
      const evidence = goldRegisteredEvidence();
      sessionStorage.setItem("chiuGoldDone", "1");
      window.name = "chiuGoldDone";
      goHome();
      return JSON.stringify(result(state, "gold_already_registered_go_home", { goldRegistered: true, goldEvidence: evidence }));
    }
    case "mypage_gold_not_registered": {
      const link = qa('a').find(function (el) { return text(el).indexOf("ゴールド会員特典内容") >= 0; }) || q('a[href*="gold/membership/index.html"]');
      if (!link) return JSON.stringify(fail(state, "missing_gold_benefits_link"));
      navigateElement(link);
      return JSON.stringify(result(state, "open_gold_membership_benefits", { goldRegistered: false }));
    }
    case "gold_membership_benefits": {
      setChecked('#terms', true);
      const btn = q('#toggleButton') || qa('a,button').find(function (el) { return text(el).indexOf("ゴールド会員を申し込む") >= 0; });
      if (btn) btn.classList && btn.classList.remove("disabled");
      if (!btn) return JSON.stringify(fail(state, "missing_gold_apply_button"));
      clickElement(btn);
      return JSON.stringify(result(state, "accept_gold_terms_and_apply"));
    }
    case "gold_payment_select": {
      const link = q('a[href*="method=credit"]') || qa('a').find(function (el) { return text(el).indexOf("クレジットカード") >= 0; });
      if (!link) return JSON.stringify(fail(state, "missing_credit_payment_link"));
      navigateElement(link);
      return JSON.stringify(result(state, "select_credit_card_payment"));
    }
    case "gold_credit_card_payment": {
      const cardNumber = val("credit_card_number", "card_number").replace(/[^0-9]/g, "");
      const exp = parseCardExp(val("credit_card_exp", "card_exp"));
      const cvv = val("credit_card_cvv", "card_cvv", "cvv").replace(/[^0-9]/g, "");
      const missing = [];
      if (!cardNumber) missing.push("credit_card_number");
      if (!exp.month || !exp.year) missing.push("credit_card_exp");
      if (!cvv) missing.push("credit_card_cvv");
      if (missing.length) return JSON.stringify(fail(state, "missing_card_data", { missing: missing }));
      setField('input[name="ccNumber"]', cardNumber);
      setSelect('select[name="ccExpirationMonth"]', exp.month);
      setSelect('select[name="ccExpirationYear"]', exp.year);
      setField('input[name="securityCode"]', cvv);
      const filled = {
        ccNumber: q('input[name="ccNumber"]') && q('input[name="ccNumber"]').value,
        month: q('select[name="ccExpirationMonth"]') && q('select[name="ccExpirationMonth"]').value,
        year: q('select[name="ccExpirationYear"]') && q('select[name="ccExpirationYear"]').value,
        cvv: q('input[name="securityCode"]') && q('input[name="securityCode"]').value
      };
      if (!filled.ccNumber || !filled.month || !filled.year || !filled.cvv) {
        return JSON.stringify(fail(state, "card_fields_not_filled", filled));
      }
      // Fields đã điền (idempotent, poll lại vẫn giữ nguyên). Chỉ bấm 次へ khi trang
      // đã load xong (ảnh render đủ + doSubmit sẵn sàng); chưa xong thì trả wait để
      // run-loop poll lại thay vì bấm sớm gây treo.
      if (!creditPageReady()) {
        return JSON.stringify(result(state, "wait_credit_page_render", {
          wait: true,
          readyState: document.readyState,
          doSubmitReady: typeof window.doSubmit === "function",
          waitedMs: Date.now() - (window.__chiuCreditFirstSeen || Date.now())
        }));
      }
      if (isCardRetryEnabled()) markCardRetrySubmitted();
      if (!submitCreditPaymentForm()) return JSON.stringify(fail(state, "credit_payment_submit_failed", filled));
      return JSON.stringify(result(state, "fill_credit_card_and_next", { expMonth: exp.month, expYear: exp.year }));
    }
    case "gold_payment_confirm": {
      clickText(/^購入$/) || submitForm(q('form[name="fepChargeIntensionConfirmActionForm"]') || q("form"));
      return JSON.stringify(result(state, "confirm_gold_payment"));
    }
    case "gold_payment_complete": {
      window.name = "chiuGoldDone";
      clickText(/^戻る$/) || clickElement(q('a[onclick*="action=success"]'));
      return JSON.stringify(result(state, "back_after_gold_complete"));
    }
    case "store_sale_tab": {
      const banner = onepieceBannerLink();
      if (!banner) return JSON.stringify(fail(state, "missing_onepiece_banner"));
      navigateElement(banner);
      return JSON.stringify(result(state, "open_onepiece_lottery_notice"));
    }
    case "onepiece_lottery_notice": {
      const link = q("#go-form-btn") || qa("a").find(function (el) { return text(el).indexOf("抽選応募画面へ") >= 0; });
      if (!link) return JSON.stringify(fail(state, "missing_onepiece_apply_link"));
      navigateElement(link);
      return JSON.stringify(result(state, "open_onepiece_lottery_apply_form"));
    }
    case "onepiece_lottery_apply_form": {
      const filled = fillOnepieceForm();
      if (filled.wait) return JSON.stringify(result(state, "wait_onepiece_store_render", filled));
      if (!filled.ok) return JSON.stringify(fail(state, "fill_onepiece_lottery_form_failed", filled));
      if (filled.dryRun) return JSON.stringify(result("onepiece_lottery_form_filled", "fill_onepiece_lottery_form_no_submit", {
        store: filled.store,
        selectedShopNo: filled.selectedShopNo,
        selectedShopLabel: filled.selectedShopLabel
      }));
      return JSON.stringify(result(state, "fill_onepiece_lottery_form_and_confirm", {
        store: filled.store,
        selectedShopNo: filled.selectedShopNo,
        selectedShopLabel: filled.selectedShopLabel
      }));
    }
    case "onepiece_lottery_apply_confirm": {
      const btn = qa("button,input[type=submit]").find(function (el) { return /応募を確定する/.test(String(el.value || "") + text(el)); }) || q("button#entry");
      if (!btn) return JSON.stringify(fail(state, "missing_onepiece_confirm_button"));
      if (options.submit === false || options.dryRun) {
        return JSON.stringify(result("onepiece_lottery_confirm_ready", "stop_before_onepiece_final_submit"));
      }
      clickElement(btn);
      return JSON.stringify(result(state, "confirm_onepiece_lottery_application"));
    }
    case "onepiece_lottery_complete":
      delayBeforeFlowComplete();
      return JSON.stringify(result("chiu_onepiece_submitted", "onepiece_lottery_complete"));
    case "onepiece_lottery_already_applied":
      delayBeforeFlowComplete();
      return JSON.stringify(result("chiu_onepiece_submitted", "onepiece_lottery_already_applied"));
    case "tracking_location_consent": {
      if (options.submit !== false && !options.dryRun) {
        if (typeof window.Onclick === "function") window.Onclick();
        else clickElement(q(".btn-close"));
      }
      return JSON.stringify(result(state, "close_tracking_consent"));
    }
    case "member_register_top": {
      const link = q('a[href*="module=memberlogin"][href*="action=reg001"]') ||
        qa('a').find(function (el) { return text(el).indexOf("新規") >= 0; });
      if (!link) return JSON.stringify(fail(state, "missing_new_register_link"));
      navigateElement(link);
      return JSON.stringify(result(state, "open_new_member_registration"));
    }
    case "terms_consent": {
      setChecked("#chkbox", true);
      if (typeof window.consentCheck === "function") window.consentCheck();
      submitForm(document.forms.input01 || q('form[name="input01"]') || q("form"));
      return JSON.stringify(result(state, "accept_terms_and_submit"));
    }
    case "email_register_input": {
      const email = val("email", "mail");
      if (!email) return JSON.stringify(fail(state, "missing_email"));
      setField('input[name="reg_mail_address"]', email);
      setField('input[name="mail_address_check"]', email);
      const emailInput = q('input[name="reg_mail_address"]');
      clickSubmitValue("次へ") || submitForm((emailInput && emailInput.form) || q("form"));
      return JSON.stringify(result(state, "fill_register_email_and_submit", { email: email }));
    }
    case "email_register_confirm": {
      const form = q('form[action*="action=regauth"]') || q("form");
      clickSubmitValue("送信") || submitForm(form);
      return JSON.stringify(result(state, "send_register_auth_email"));
    }
    case "email_auth_code_input": {
      const code = val("auth_code", "authCode", "email_code", "emailCode", "inputcode", "otp");
      if (!code) return JSON.stringify(fail(state, "need_register_otp", { needs_otp: true }));
      setField('input[name="inputcode"]', code);
      const codeInput = q('input[name="inputcode"]');
      clickSubmitValue("次へ") || submitForm((codeInput && codeInput.form) || q("form"));
      return JSON.stringify(result(state, "fill_register_otp_and_submit"));
    }
    case "member_info_input": {
      const mapped = {
        pin: normalizeDigits(val("pin")),
        phone: normalizeDigits(val("phone", "tel")),
        lastName: val("last_name", "lastName", "sei"),
        firstName: val("first_name", "firstName", "mei"),
        lastKana: val("last_name_kana", "katakana_last_name", "lastNameKana", "seikana"),
        firstKana: val("first_name_kana", "katakana_first_name", "firstNameKana", "meikana"),
        postal: normalizeDigits(val("postal_code", "postalCode", "zip")),
        prefecture: val("prefecture", "prefcode"),
        city: val("city", "adrs1"),
        addressRest: val("address_rest", "addressRest", "adrs2", "address"),
        dob: normalizeDob(val("dob", "birth_date", "birthday", "birthdate")),
        gender: normalizeGender(val("gender", "sex"))
      };
      const missing = requireFields([
        { name: "pin", value: mapped.pin },
        { name: "phone", value: mapped.phone },
        { name: "last_name", value: mapped.lastName },
        { name: "first_name", value: mapped.firstName },
        { name: "last_name_kana", value: mapped.lastKana },
        { name: "first_name_kana", value: mapped.firstKana },
        { name: "postal_code", value: mapped.postal },
        { name: "prefecture", value: mapped.prefecture },
        { name: "city", value: mapped.city },
        { name: "address_rest", value: mapped.addressRest }
      ]);
      if (missing.length && !options.allowPartial) {
        return JSON.stringify(fail(state, "missing_register_info", { missing: missing }));
      }
      setField('input[name="password"]', mapped.pin);
      setField('input[name="tel"]', mapped.phone);
      setField('input[name="sei"]', mapped.lastName);
      setField('input[name="mei"]', mapped.firstName);
      setField('input[name="seikana"]', mapped.lastKana);
      setField('input[name="meikana"]', mapped.firstKana);
      setField('input[name="zip"]', mapped.postal);
      setPrefecture(mapped.prefecture);
      setField('input[name="adrs1"]', mapped.city);
      setField('input[name="adrs2"]', mapped.addressRest);
      if (mapped.dob) setField('input[name="birthday"]', mapped.dob);
      if (mapped.gender) setChecked('input[name="sex"][value="' + mapped.gender + '"]', true);
      submitForm(document.forms.input01 || q('form[name="input01"]') || q("form"));
      return JSON.stringify(result(state, "fill_member_info_and_submit", { filled: mapped }));
    }
    case "member_info_confirm": {
      submitForm(document.forms.inputreg || q('form[name="inputreg"]') || q("form"));
      return JSON.stringify(result(state, "confirm_member_info_and_register"));
    }
    case "member_register_complete": {
      const link = q('a[href="ymd://"]');
      if (link) navigateElement(link);
      return JSON.stringify(result(state, "launch_app_after_registration", { registered: true }));
    }
    case "unexpected_error_restart": {
      const link = q('a[href*="module=authorize"][href*="action=authorize2"]');
      if (!link) return JSON.stringify(fail(state, "missing_restart_link"));
      navigateElement(link);
      return JSON.stringify(result(state, "restart_after_unexpected_error"));
    }
    case "ymd_common_error_no_retry":
      return JSON.stringify(result(state, "fail_no_retry", {
        noRetry: true,
        reason: "member_or_system_error"
      }));
    case "gold_card_unusable":
    case "gold_card_unusable_no_retry":
      return JSON.stringify(result(state, "card_unusable", {
        reason: "card_unusable"
      }));
    case "loading":
      return JSON.stringify(result(state, "wait_loading", { wait: true }));
    default:
      return JSON.stringify(fail(state, "no_action"));
  }
})()
`;
}

let savedProfile = {};
let savedOptions = {};

async function detectInternal(idx) {
  return parsePageResult(await evalInWebView(idx || 0, pageProgram({}, {}, "detect")));
}

async function screenInternal(idx) {
  return parsePageResult(await evalInWebView(idx || 0, pageProgram({}, {}, "screen")));
}

async function stepInternal(idx, profile, options) {
  return parsePageResult(await evalInWebView(idx || 0, pageProgram(profile || {}, options || {}, "step")));
}

async function runInternal(idx, profile, options) {
  const opts = Object.assign({
    maxSteps: 20,
    delayMs: 300,
    pollMs: 500,
    waitTimeoutMs: 15000,
    stablePolls: 2
  }, options || {});
  const history = [];
  for (let step = 0; step < opts.maxSteps; step++) {
    const res = await stepInternal(idx || 0, profile || {}, opts);
    if (!res.ok && res.state === "unknown" && res.action === "no_action") {
      history.push(res);
      const wait = await waitAfterActionInternal(idx || 0, res, Object.assign({}, opts, { noWait: false }));
      if (wait && (opts.includeWaits || !wait.ok)) history.push(wait);
      if (wait && !wait.ok) break;
      continue;
    }
    history.push(res);
    if (!res.ok || res.state === "chiu_onepiece_submitted" || res.state === "onepiece_lottery_confirm_ready" || res.state === "ymd_common_error_no_retry" || res.state === "gold_card_unusable" || res.state === "gold_card_unusable_no_retry" || res.state === "login_identity_mismatch_no_retry" || res.state === "login_help_redirect_no_retry" || res.state === "login_email_auth_failed_no_retry" || res.state === "login_identity_missing_no_retry") break;
    if (res.action === "done") break;
    const wait = await waitAfterActionInternal(idx || 0, res, opts);
    if (wait && (opts.includeWaits || !wait.ok)) history.push(wait);
    if (wait && !wait.ok) break;
  }
  return { ok: true, history: history };
}

async function waitAfterActionInternal(idx, previous, options) {
  const opts = Object.assign({ delayMs: 300, pollMs: 500, waitTimeoutMs: 15000, stablePolls: 2 }, options || {});
  if (opts.noWait || opts.submit === false || opts.dryRun) {
    await sleep(opts.delayMs);
    return { ok: true, action: "wait_skipped" };
  }

  const start = Date.now();
  const firstState = previous && previous.state;
  const firstUrl = previous && previous.url;
  const expectsNavigation = [
    "open_login",
    "back_to_first_screen",
    "confirm_back_to_first_screen",
    "fill_login_email_and_submit",
    "send_login_auth_email",
    "open_login_url_from_email",
    "fill_login_identity_and_submit",
    "fill_login_otp_and_submit",
    "open_app_top_after_login",
    "open_new_member_registration",
    "accept_terms_and_submit",
    "fill_register_email_and_submit",
    "send_register_auth_email",
    "fill_register_otp_and_submit",
    "fill_member_info_and_submit",
    "confirm_member_info_and_register",
    "launch_app_after_registration",
    "restart_after_unexpected_error",
    "open_mypage",
    "gold_already_registered_go_home",
    "open_gold_membership_benefits",
    "accept_gold_terms_and_apply",
    "select_credit_card_payment",
    "fill_credit_card_and_next",
    "confirm_gold_payment",
    "back_after_gold_complete",
    "close_tracking_consent",
    "open_onepiece_lottery_notice",
    "open_onepiece_lottery_apply_form",
    "fill_onepiece_lottery_form_and_confirm",
    "confirm_onepiece_lottery_application"
  ].indexOf(previous && previous.action) >= 0;
  const goldPaymentActions = [
    "accept_gold_terms_and_apply",
    "select_credit_card_payment",
    "fill_credit_card_and_next",
    "confirm_gold_payment"
  ];
  const timeoutMs = goldPaymentActions.indexOf(previous && previous.action) >= 0
    ? Number(opts.goldPaymentWaitTimeoutMs || opts.paymentWaitTimeoutMs || opts.waitTimeoutMs || 15000)
    : Number(opts.waitTimeoutMs || 15000);
  let lastKey = "";
  let stableCount = 0;
  let latest = null;

  await sleep(Math.max(0, Number(opts.delayMs || 0)));
  while (Date.now() - start < timeoutMs) {
    latest = await screenInternal(idx || 0);
    const key = [latest.state, latest.url, latest.readyState, latest.score].join("|");
    if (key === lastKey) stableCount += 1;
    else {
      lastKey = key;
      stableCount = 1;
    }

    const changed = latest.state !== firstState || latest.url !== firstUrl;
    const ready = !latest.readyState || latest.readyState === "interactive" || latest.readyState === "complete";
    if (changed && ready && stableCount >= Number(opts.stablePolls || 2)) {
      return {
        ok: true,
        action: "wait_screen_changed",
        waitedMs: Date.now() - start,
        from: { state: firstState, url: firstUrl },
        to: { state: latest.state, url: latest.url, readyState: latest.readyState }
      };
    }

    // Some actions update the current page in-place. If the page is stable and
    // ready, move on instead of burning the whole timeout.
    if (!expectsNavigation && !changed && ready && stableCount >= Math.max(3, Number(opts.stablePolls || 2) + 1)) {
      return {
        ok: true,
        action: "wait_screen_stable",
        waitedMs: Date.now() - start,
        state: latest.state,
        url: latest.url,
        readyState: latest.readyState
      };
    }
    await sleep(Number(opts.pollMs || 500));
  }

  return {
    ok: false,
    action: "wait_timeout",
    waitedMs: Date.now() - start,
    from: { state: firstState, url: firstUrl },
    last: latest
  };
}

rpc.exports = {
  count: function () {
    return allWK().length;
  },
  runjs: function (idx, code) {
    return evalInWebView(idx || 0, code);
  },
  dumpdom: function (idx) {
    return evalInWebView(idx || 0, "document.documentElement.outerHTML");
  },
  chiudetect: function (idx) {
    return detectInternal(idx || 0).then((res) => JSON.stringify(res));
  },
  chiuscreen: function (idx) {
    return screenInternal(idx || 0).then((res) => JSON.stringify(res));
  },
  chiusetprofile: function (profileJson) {
    savedProfile = parseObject(profileJson);
    return JSON.stringify({ ok: true, profile: savedProfile });
  },
  chiusetauthcode: function (code) {
    savedProfile.auth_code = String(code || "").trim();
    return JSON.stringify({ ok: true });
  },
  chiustep: function (idx, profileJson, optionsJson) {
    const profile = Object.assign({}, savedProfile, parseObject(profileJson));
    const options = Object.assign({}, savedOptions, parseObject(optionsJson));
    return stepInternal(idx || 0, profile, options).then((res) => JSON.stringify(res));
  },
  chiurun: function (idx, profileJson, optionsJson) {
    const profile = Object.assign({}, savedProfile, parseObject(profileJson));
    const options = Object.assign({}, savedOptions, parseObject(optionsJson));
    return runInternal(idx || 0, profile, options).then((res) => JSON.stringify(res));
  }
};

globalThis.runJS = (code, idx) => evalInWebView(idx || 0, code).then((res) => console.log(res) || res);
globalThis.dumpDOM = (idx) => evalInWebView(idx || 0, "document.documentElement.outerHTML")
  .then((res) => console.log("len=" + (res ? res.length : 0)) || res);

globalThis.setChiuProfile = function (profile) {
  savedProfile = typeof profile === "string" ? JSON.parse(profile) : (profile || {});
  console.log("[chiu-agent] profile set: " + (savedProfile.email || "(no email)"));
  return savedProfile;
};
globalThis.setChiuAuthCode = function (code) {
  savedProfile.auth_code = String(code || "").trim();
  console.log(JSON.stringify({ ok: true }, null, 2));
};
globalThis.chiuDetect = (idx) => detectInternal(idx || 0)
  .then((res) => console.log(JSON.stringify(res, null, 2)) || res);
globalThis.chiuScreen = (idx) => screenInternal(idx || 0)
  .then((res) => console.log(JSON.stringify(res, null, 2)) || res);
globalThis.chiuStep = (profile, options, idx) => stepInternal(idx || 0, Object.assign({}, savedProfile, profile || {}), Object.assign({}, savedOptions, options || {}))
  .then((res) => console.log(JSON.stringify(res, null, 2)) || res);
globalThis.yamadaRun = (profile, options, idx) => runInternal(idx || 0, Object.assign({}, savedProfile, profile || {}), Object.assign({}, savedOptions, options || {}))
  .then((res) => console.log(JSON.stringify(res, null, 2)) || res);

console.log("[chiu-agent] loaded - WKWebView count:", allWK().length);
