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
    { pre: "13", area: "練馬区", shopNo: "258", shopName: "ﾃｯｸﾗﾝﾄﾞ練馬本店" },
    { pre: "13", area: "練馬区", shopNo: "219", shopName: "ﾃｯｸﾗﾝﾄﾞ大泉学園店PC館" },
    { pre: "13", area: "練馬区", shopNo: "809", shopName: "ﾃｯｸﾗﾝﾄﾞ平和台駅前店" },
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
    return q('#category009 a[href*="0929_lottery-pcs/notice.html"]') ||
      (q('#banner_impression-banner_topics_0000008430') && q('#banner_impression-banner_topics_0000008430').closest("a")) ||
      qa('a').find(function (el) { return /ONE PIECE|ワンピース|抽選販売/.test(text(el) + " " + String(el.href || "")); });
  }
  function ensureSyntheticShopRadio(store) {
    const container = q("#container") || q("form") || document.body;
    let radio = q('input[type="radio"][value="' + store.shopNo + '"]', container) || q('input[type="radio"][value="' + store.shopNo + '"]');
    if (radio) return radio;
    radio = document.createElement("input");
    radio.type = "radio";
    radio.id = "shop";
    radio.className = "shop";
    radio.name = store.area;
    radio.value = store.shopNo;
    radio.style.display = "none";
    container.appendChild(radio);
    return radio;
  }
  function selectOnepieceStore(store) {
    if (!setSelect("#pre", store.pre)) return { ok: false, missing: "prefecture" };
    const areaSelect = q("#area");
    if (!areaSelect) return { ok: false, missing: "area_select" };
    if (!setSelect("#area", store.area)) {
      const opt = document.createElement("option");
      opt.value = store.area;
      opt.textContent = store.area;
      areaSelect.appendChild(opt);
      setSelect("#area", store.area);
    }
    const radio = ensureSyntheticShopRadio(store);
    radio.checked = true;
    radio.dispatchEvent(new Event("input", { bubbles: true }));
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    setField("#selected_shop_no", store.shopNo);
    return { ok: true, store: store };
  }
  function fillOnepieceForm() {
    const product = q('input[type="radio"][name="items[]"][value="01"]') || q('input[type="radio"][name="items[]"]');
    if (product) {
      product.checked = true;
      product.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const store = preferredOnepieceStore();
    const selected = selectOnepieceStore(store);
    if (!selected.ok) return selected;
    setField('#selected_campaign', val("selected_campaign", "onepiece_campaign"));
    setChecked('input[name="check_privacy"]', true);
    const btn = q("button#entry") || qa('button,input[type="submit"]').find(function (el) { return /応募内容の確認へ進む/.test(String(el.value || "") + text(el)); });
    if (!btn) return { ok: false, missing: "entry_button", store: store };
    clickElement(btn);
    return { ok: true, store: store };
  }
  function currentScreen() {
    const b = bodyText();
    const title = document.title || "";
    const href = location.href || "";
    if ((href.indexOf("0929_lottery-pcs/notice.html") >= 0 || /ONE PIECE/.test(title + " " + b)) && q("#go-form-btn")) return "onepiece_lottery_notice";
    if (/すでにお申込み済み|申込済み|お申込み済み/.test(b) && /lotterysale001/.test(href)) return "onepiece_lottery_already_applied";
    if (q('form[action*="lotterysale001"]') && q("#pre") && q("#area") && q("#entry")) return "onepiece_lottery_apply_form";
    if (/応募確認/.test(title + " " + b) && /応募を確定する/.test(b) && q('form[action*="lotterysale002"]')) return "onepiece_lottery_apply_confirm";
    if (/lotterysale003/.test(href) || /応募完了|応募を受け付けました|ご応募ありがとうございました/.test(title + " " + b)) return "onepiece_lottery_complete";
    if (q('input[name="login_address"]') && q('input[name="login_address_check"]')) return "login_email_input";
    if (q('input[name="inputcode"]') && /認証コード/.test(b) && /ログイン|メール/.test(b)) return "login_auth_code_input";
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
      clickText(/^次へ$/) || submitForm(q('form[name="creditFepChargePaymentInfoEntryActionForm"]') || q("form"));
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
      if (!filled.ok) return JSON.stringify(fail(state, "fill_onepiece_lottery_form_failed", filled));
      return JSON.stringify(result(state, "fill_onepiece_lottery_form_and_confirm", { store: filled.store }));
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
      return JSON.stringify(result("chiu_onepiece_submitted", "onepiece_lottery_complete"));
    case "onepiece_lottery_already_applied":
      return JSON.stringify(result("chiu_onepiece_submitted", "onepiece_lottery_already_applied"));
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
    if (!res.ok || res.wait || res.state === "chiu_onepiece_submitted" || res.state === "onepiece_lottery_confirm_ready") break;
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
    "fill_login_email_and_submit",
    "send_login_auth_email",
    "fill_login_otp_and_submit",
    "open_app_top_after_login",
    "open_mypage",
    "gold_already_registered_go_home",
    "open_gold_membership_benefits",
    "accept_gold_terms_and_apply",
    "select_credit_card_payment",
    "fill_credit_card_and_next",
    "confirm_gold_payment",
    "back_after_gold_complete",
    "open_onepiece_lottery_notice",
    "open_onepiece_lottery_apply_form",
    "fill_onepiece_lottery_form_and_confirm",
    "confirm_onepiece_lottery_application"
  ].indexOf(previous && previous.action) >= 0;
  let lastKey = "";
  let stableCount = 0;
  let latest = null;

  await sleep(Math.max(0, Number(opts.delayMs || 0)));
  while (Date.now() - start < Number(opts.waitTimeoutMs || 15000)) {
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
