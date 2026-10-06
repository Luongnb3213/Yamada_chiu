#!/usr/bin/env python3
"""Free iPhone RAM before a row: kill leftover app processes, respring when memory is low.

Switching between many Crane containers fills the phone's memory; iOS jetsam then kills
SpringBoard/frida and the batch loses the device. Running this before each row keeps
memory headroom. Never fails the row: any error is printed and exit code is 0.
"""
from __future__ import annotations

import argparse
import json
import sys
import time

KILL_NAMES = {"yamadadenki", "CraneApplication", "com.apple.WebKit.WebContent", "com.apple.WebKit.Networking"}

SB_JS = r"""
const g = n => Module.getGlobalExportByName(n);
const sysctlbyname = new NativeFunction(g('sysctlbyname'), 'int', ['pointer', 'pointer', 'pointer', 'pointer', 'size_t']);
const getClass = new NativeFunction(g('objc_getClass'), 'pointer', ['pointer']);
const sel = new NativeFunction(g('sel_registerName'), 'pointer', ['pointer']);
const msgPtr = g('objc_msgSend');
const send0 = new NativeFunction(msgPtr, 'pointer', ['pointer', 'pointer']);
const sendBool = new NativeFunction(msgPtr, 'bool', ['pointer', 'pointer']);
const sendPresent = new NativeFunction(msgPtr, 'void', ['pointer', 'pointer', 'bool', 'bool', 'pointer']);
function S(s) { return sel(Memory.allocUtf8String(s)); }
function lockMgr() {
  const cls = getClass(Memory.allocUtf8String('SBLockScreenManager'));
  return cls.isNull() ? null : send0(cls, S('sharedInstance'));
}
function safeFlagPath() {
  const m = Process.enumerateModules().find(x => x.name === 'libellekit.dylib');
  return m ? m.path.replace('/usr/lib/libellekit.dylib', '') + '/var/mobile/.eksafemode' : null;
}
rpc.exports = {
  // ElleKit Safe Mode: no tweaks (Crane) load, so the app cannot open in containers.
  safeMode() {
    const p = safeFlagPath();
    const access = new NativeFunction(g('access'), 'int', ['pointer', 'int']);
    return { flag: !!p && access(Memory.allocUtf8String(p), 0) === 0, crane: Process.enumerateModules().some(x => x.name === 'CraneSB.dylib') };
  },
  // After Safe Mode SpringBoard may forget the jailbreak-installed Crane app: re-register it.
  uicacheCrane() {
    const m = Process.enumerateModules().find(x => x.name === 'libellekit.dylib'); if (!m) return -1;
    const jb = m.path.replace('/usr/lib/libellekit.dylib', '');
    const spawn = new NativeFunction(g('posix_spawn'), 'int', ['pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'pointer']);
    const waitpid = new NativeFunction(g('waitpid'), 'int', ['int', 'pointer', 'int']);
    const strs = [jb + '/usr/bin/uicache', '-p', jb + '/Applications/CraneApplication.app'].map(x => Memory.allocUtf8String(x));
    const argv = Memory.alloc(Process.pointerSize * 4);
    strs.forEach((x, i) => argv.add(i * Process.pointerSize).writePointer(x));
    argv.add(3 * Process.pointerSize).writePointer(ptr(0));
    const pid = Memory.alloc(4);
    if (spawn(pid, strs[0], ptr(0), ptr(0), argv, ptr(0)) !== 0) return -2;
    const st = Memory.alloc(4); waitpid(pid.readS32(), st, 0);
    return st.readS32();
  },
  clearSafeMode() {
    const p = safeFlagPath(); if (!p) return -1;
    return new NativeFunction(g('unlink'), 'int', ['pointer'])(Memory.allocUtf8String(p));
  },
  level() {
    const b = Memory.alloc(4), l = Memory.alloc(8); l.writeU64(4);
    sysctlbyname(Memory.allocUtf8String('kern.memorystatus_level'), b, l, ptr(0), 0);
    return b.readS32();
  },
  // Screen asleep (black) keeps the app from running even when not locked: turn it on.
  wake() {
    const bc = getClass(Memory.allocUtf8String('SBBacklightController'));
    if (bc.isNull()) return null;
    const inst = send0(bc, S('sharedInstance'));
    if (sendBool(inst, S('screenIsOn'))) return false;
    const sendLong = new NativeFunction(msgPtr, 'void', ['pointer', 'pointer', 'long']);
    return new Promise(resolve => ObjCMain(() => { sendLong(inst, S('turnOnScreenFullyWithBacklightSource:'), 0); resolve(true); }));
  },
  locked() { const m = lockMgr(); return m ? !!sendBool(m, S('isUILocked')) : null; },
  // Open an app like tapping its icon. frida's device.spawn() injects an agent into launchd,
  // and that agent crashing kills launchd -> kernel panic (seen in launchd-*.ips reports).
  openApp(bundleId) {
    const sendPtr = new NativeFunction(msgPtr, 'pointer', ['pointer', 'pointer', 'pointer']);
    const sendBoolPtr = new NativeFunction(msgPtr, 'bool', ['pointer', 'pointer', 'pointer']);
    const ns = sendPtr(getClass(Memory.allocUtf8String('NSString')), S('stringWithUTF8String:'), Memory.allocUtf8String(bundleId));
    const ws = send0(getClass(Memory.allocUtf8String('LSApplicationWorkspace')), S('defaultWorkspace'));
    return !!sendBoolPtr(ws, S('openApplicationWithBundleID:'), ns);
  },
  unlock() {
    const m = lockMgr(); if (!m) return 'no-manager';
    return new Promise(resolve => {
      ObjCMain(() => {
        try {
          send0(m, S('lockScreenViewControllerRequestsUnlock'));
          const cs = getClass(Memory.allocUtf8String('SBCoverSheetPresentationManager'));
          if (!cs.isNull()) sendPresent(send0(cs, S('sharedInstance')), S('setCoverSheetPresented:animated:withCompletion:'), 0, 0, ptr(0));
          resolve('ok');
        } catch (e) { resolve(String(e)); }
      });
    });
  },
  // Clean SpringBoard relaunch (like a tweak's Respring button). Killing SpringBoard looks
  // like a crash to ElleKit and drops the phone into Safe Mode.
  relaunch() {
    const sendFlag = new NativeFunction(msgPtr, 'void', ['pointer', 'pointer', 'bool']);
    const svc = send0(getClass(Memory.allocUtf8String('FBSystemService')), S('sharedInstance'));
    ObjCMain(() => { sendFlag(svc, S('exitAndRelaunch:'), 1); });
    return 'ok';
  }
};
// Run on the main thread via dispatch_async_f on the main queue.
function ObjCMain(fn) {
  const q = g('_dispatch_main_q');
  const dispatch = new NativeFunction(g('dispatch_async_f'), 'void', ['pointer', 'pointer', 'pointer']);
  const cb = new NativeCallback(() => { fn(); }, 'void', ['pointer']);
  ObjCMain._keep = cb;
  dispatch(q, ptr(0), cb);
}
"""


def springboard(device):
    for p in device.enumerate_processes():
        if p.name == "SpringBoard":
            return p
    return None


def sb_call(device, fn):
    sb = springboard(device)
    if sb is None:
        raise RuntimeError("SpringBoard not running")
    session = device.attach(sb.pid)
    try:
        script = session.create_script(SB_JS)
        script.load()
        return fn(script.exports_sync)
    finally:
        try:
            session.detach()
        except Exception:
            pass


def launch_app(device, bundle_id: str, timeout: float = 20) -> int:
    """Open bundle_id through SpringBoard (no launchd injection) and return its pid."""
    if not sb_call(device, lambda ex: ex.open_app(bundle_id)):
        raise RuntimeError(f"SpringBoard could not open {bundle_id}")
    deadline = time.time() + timeout
    while time.time() < deadline:
        for app in device.enumerate_applications(identifiers=[bundle_id]):
            if app.pid:
                return app.pid
        time.sleep(0.5)
    raise RuntimeError(f"{bundle_id} did not start within {timeout}s")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--respring-below", type=int, default=0, help="Respring when kern.memorystatus_level (%% free) is below this.")
    parser.add_argument("--force-respring", action="store_true")
    parser.add_argument("--settle-seconds", type=float, default=8, help="Pause after killing leftover apps.")
    args = parser.parse_args()
    try:
        import frida
    except Exception as exc:
        print(f"[ram-guard] cannot import frida: {exc}", flush=True)
        return 0
    try:
        device = frida.get_device(args.device_id, timeout=10)
        killed = []
        for p in device.enumerate_processes():
            if p.name in KILL_NAMES:
                try:
                    device.kill(p.pid)
                    killed.append(p.name)
                except Exception:
                    pass
        # Give iOS time to reclaim the killed apps' compressed memory before the next row.
        time.sleep(args.settle_seconds)
        level = sb_call(device, lambda ex: ex.level())
        info = {"killed": killed, "level_before": level, "respring": False}
        safe = sb_call(device, lambda ex: ex.safe_mode())
        if safe["flag"] or not safe["crane"]:
            info["safe_mode"] = safe
            info["safe_mode_clear"] = sb_call(device, lambda ex: ex.clear_safe_mode())
        if args.force_respring or level < args.respring_below or "safe_mode" in info:
            old = springboard(device)
            try:
                sb_call(device, lambda ex: ex.relaunch())
            except Exception:
                pass  # session drops as SpringBoard exits
            info["respring"] = True
            deadline = time.time() + 60
            while time.time() < deadline:
                time.sleep(3)
                try:
                    now = springboard(device)
                except Exception:
                    now = None
                if now is not None and now.pid != old.pid:
                    break
            time.sleep(12)
            sb_call(device, lambda ex: ex.wake())
            # Unlock can be ignored while SpringBoard is still settling: retry until it sticks.
            for attempt in range(4):
                info["unlock"] = sb_call(device, lambda ex: ex.unlock())
                time.sleep(3)
                info["locked_after"] = sb_call(device, lambda ex: ex.locked())
                info["unlock_attempts"] = attempt + 1
                if info["locked_after"] is False:
                    break
                time.sleep(3)
            info["level_after"] = sb_call(device, lambda ex: ex.level())
            if "safe_mode" in info:
                info["uicache_crane"] = sb_call(device, lambda ex: ex.uicache_crane())
        else:
            if sb_call(device, lambda ex: ex.wake()):
                info["woke_screen"] = True
                time.sleep(2)
        if not info["respring"] and sb_call(device, lambda ex: ex.locked()):
            # Jetsam may have restarted SpringBoard between rows, leaving the lock screen up.
            for attempt in range(4):
                info["unlock"] = sb_call(device, lambda ex: ex.unlock())
                time.sleep(3)
                info["locked_after"] = sb_call(device, lambda ex: ex.locked())
                if info["locked_after"] is False:
                    break
        print("[ram-guard] " + json.dumps(info, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(f"[ram-guard] warning: {exc}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
