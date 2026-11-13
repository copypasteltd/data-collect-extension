// Harness watchdog values only; these are not recording limits or product SLOs.
export function validationBudgets(environment = {}) {
  const read = (name, fallback, maximum) => {
    const raw = environment[name];
    if (raw === undefined) return fallback;
    if (typeof raw !== "string" || !/^[1-9][0-9]{0,8}(?![\s\S])/.test(raw)) throw new Error("invalid_validation_budget");
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > maximum) throw new Error("invalid_validation_budget");
    return value;
  };
  return { scenarioMs: read("VALIDATION_SCENARIO_MS", 300000, 86400000),
    matrixMs: read("VALIDATION_MATRIX_MS", 3600000, 86400000),
    cleanupMs: read("VALIDATION_CLEANUP_MS", 15000, 120000) };
}

// Observation deadline only: a timed-out filesystem promise is observed, not
// magically cancelled. It must never start a later Chrome scenario after abort.
export function validationStep(operation, { timeoutMs, signal, timers = { setTimeout, clearTimeout } } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 86400000)
    return Promise.reject(new Error("invalid_validation_step_budget"));
  return new Promise((resolve, reject) => {
    let done = false, timer;
    const settle = (accept, value) => {
      if (done) return;
      done = true; timers.clearTimeout(timer); signal?.removeEventListener("abort", abort);
      accept(value);
    };
    const abort = () => settle(reject, new Error("validation_interrupted"));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timer = timers.setTimeout(() => settle(reject, new Error("validation_step_timeout")), timeoutMs);
    Promise.resolve().then(() => {
      if (done) return undefined;
      return operation();
    }).then((value) => settle(resolve, value), (error) => settle(reject, error));
  });
}

export function validationEnvironment(environment, directories, { executable, flags = {}, fontPath, nativeHost = false } = {}) {
  const env = Object.create(null);
  // Never copy the ambient environment wholesale. The OS launcher remains
  // responsible for network/filesystem isolation and resource enforcement.
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "LANG", "LC_ALL"])
    if (typeof environment[name] === "string") env[name] = environment[name];
  Object.assign(env, { HOME: directories.home, USERPROFILE: directories.home,
    APPDATA: directories.appdata, LOCALAPPDATA: directories.localappdata,
    TEMP: directories.temp, TMP: directories.temp, TMPDIR: directories.temp,
    PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", CHROME_BIN: executable });
  // Native-host release runs retain Windows Known Folder resolution. Redirecting
  // USERPROFILE/LOCALAPPDATA made Chrome treat the explicit test profile as its
  // default directory and refuse remote debugging. The test still supplies its
  // own --user-data-dir; this is not an OS isolation mode.
  if (nativeHost) for (const name of ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ProgramData"])
    if (typeof environment[name] === "string") env[name] = environment[name];
  for (const [name, value] of Object.entries(flags)) {
    if (!/^TEST_[A-Z0-9_]+(?![\s\S])/.test(name) || typeof value !== "string" || value.length > 256)
      throw new Error("invalid_scenario_flags");
    env[name] = value;
  }
  if (fontPath) env.TEST_FONT_PATH = fontPath;
  return env;
}
