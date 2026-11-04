/* Local launcher UI. Game and save operations are supplied by launcherAPI. */
(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const home = byId("home");
  const layer = byId("dialog-layer");
  const dialog = layer.querySelector(".dialog");
  const views = ["sync", "preview", "cloud", "cloud-preview", "busy", "result", "install", "options", "controller", "uninstall", "complete-preview"];
  let screen = "home";
  let busy = false;
  let externalBusy = false;
  let preview = null;
  let status = null;
  let cloud = null;
  let cloudPreview = null;
  let cloudDirection = "download";
  let uninstallPlan = null;
  let controller = null;
  let controllerChoice = null;
  let supportNotice = "";
  let setup = null;
  let sourceSide = "arm64";
  let selection = [];
  let resultFocus = "open-sync";
  let selected = null;
  let operation = 0;
  let inputMode = "keyboard";
  let disposed = false;

  function api() {
    const value = window.launcherAPI;
    if (!value || ["status", "preview", "sync", "play", "exit", "setupStatus", "browseGame", "install", "uninstall"].some(key => typeof value[key] !== "function")) {
      throw new Error("The launcher is unavailable. Close it and try again.");
    }
    return value;
  }

  function text(id, value) { byId(id).textContent = value; }
  function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
  function files(value) { return value === null ? "Unavailable" : `${value} ${value === 1 ? "file" : "files"}`; }
  function message(error) {
    const value = error && typeof error.message === "string" ? error.message : "Something went wrong. Please try again.";
    return value.slice(0, 800);
  }
  function dateParts(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return {
      date: date.toLocaleDateString(undefined, {day:"2-digit", month:"short"}),
      time: date.toLocaleTimeString(undefined, {hour:"2-digit", minute:"2-digit", hour12:false}),
      full: date.toLocaleString(undefined, {dateStyle:"medium", timeStyle:"short", hour12:false})
    };
  }
  function dateLabel(value, available = true) {
    return dateParts(value)?.full || (available ? "Date unavailable" : "Empty");
  }
  function sideLabel(side) { return side === "arm64" ? "ARM64" : "Steam"; }
  function destinationSide() { return sourceSide === "arm64" ? "steam" : "arm64"; }
  function copyDirection() { return `${sourceSide}-to-${destinationSide()}`; }
  function slotInfo(side, id) {
    return id === "auto" ? status?.[side]?.autosave : status?.[side]?.slots?.find(item => item.id === id);
  }
  function selectedIDs() {
    if (selection !== "all") return selection;
    const current = status?.[sourceSide];
    const ids = (current?.slots || []).filter(item => item.available).map(item => item.id);
    if (current?.autosave?.available) ids.unshift("auto");
    return ids;
  }
  function hasSourceSaves() {
    const side = status?.[sourceSide];
    return Boolean(side?.currentCount > 0 || side?.autosave?.available || side?.slots?.some(item => item.available));
  }
  function copyRestriction() {
    const support = directionSupport(copyDirection());
    if (externalBusy) return "Close the game before copying local saves.";
    if (support.supported === false) return support.reason || "Copying from this version is unavailable.";
    if (!Array.isArray(status?.[sourceSide]?.slots)) return "Save slot details could not be read. Reopen Local saves.";
    if (!hasSourceSaves()) return status?.[sourceSide]?.detail || "No current saves are available in this version.";
    if (support.allOnly) return support.reason || "Choose All for the first copy to this version.";
    return "";
  }
  function canCopySelection() {
    const support = directionSupport(copyDirection());
    return !busy && !externalBusy && support.supported !== false && Array.isArray(status?.[sourceSide]?.slots) && hasSourceSaves() &&
      (selection === "all" || (!support.allOnly && selection.length > 0 && selection.every(id => slotInfo(sourceSide, id)?.available)));
  }
  function dateRows(element, rows) {
    element.replaceChildren();
    for (const item of rows) {
      const row = document.createElement("div");
      row.className = "save-date-row";
      row.dataset.saveId = String(item.id);
      for (const value of [item.id === "auto" ? "Autosave" : `Slot ${item.id}`, item.source, item.destination]) {
        const cell = document.createElement("span");
        cell.textContent = value;
        row.append(cell);
      }
      element.append(row);
    }
    element.scrollTop = 0;
  }
  function previewScrollHint() {
    const list = byId("preview-entries");
    byId("preview-navigation").hidden = screen !== "preview" || list.scrollHeight <= list.clientHeight + 1;
    const warnings = byId("complete-warnings");
    byId("complete-navigation").hidden = screen !== "complete-preview" || warnings.hidden || warnings.scrollHeight <= warnings.clientHeight + 1;
  }
  function scrollReview(delta, page = false) {
    const list = byId(screen === "complete-preview" ? "complete-warnings" : "preview-entries");
    list.scrollBy({top:delta * Math.max(40, list.clientHeight * (page ? .85 : .4)), behavior:"instant"});
  }

  function buttons() {
    const scope = screen === "home" ? home : dialog;
    return Array.from(scope.querySelectorAll("button[data-action]")).filter(button => !button.disabled && button.getClientRects().length > 0);
  }
  function select(button, focus = true) {
    document.querySelectorAll(".is-selected").forEach(item => item.classList.remove("is-selected"));
    selected = button || null;
    if (!button) return;
    if (inputMode !== "pointer") button.classList.add("is-selected");
    if (focus) button.focus({preventScroll: true});
    button.scrollIntoView({block: "nearest", inline: "nearest", behavior: "instant"});
  }
  function initialFocus(preferred) {
    const available = buttons();
    select(available.includes(preferred) ? preferred : available[0]);
    if (!available.length && screen !== "home") dialog.focus({preventScroll: true});
  }
  function move(delta) {
    if (busy) return;
    const available = buttons();
    if (!available.length) return;
    inputMode = "gamepad";
    const current = available.indexOf(selected);
    const next = current < 0 ? (delta > 0 ? 0 : available.length - 1) : (current + delta + available.length) % available.length;
    select(available[next]);
  }
  function navigate(key) {
    if (["preview", "complete-preview"].includes(screen) && ["ArrowUp", "ArrowDown"].includes(key)) {
      scrollReview(key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (screen !== "sync") { move(["ArrowUp", "ArrowLeft"].includes(key) ? -1 : 1); return; }
    const rows = [".save-tabs", ".slot-grid", ".save-actions"].map(selector =>
      Array.from(dialog.querySelectorAll(`${selector} button[data-action]`)).filter(button => !button.disabled));
    const row = rows.findIndex(items => items.includes(selected));
    if (row < 0) { initialFocus(byId(`tab-${sourceSide}`)); return; }
    inputMode = "gamepad";
    const horizontal = key === "ArrowLeft" || key === "ArrowRight";
    const delta = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
    if (horizontal) {
      const items = rows[row];
      select(items[(items.indexOf(selected) + delta + items.length) % items.length]);
    } else {
      let next = row + delta;
      while (next >= 0 && next < rows.length && !rows[next].length) next += delta;
      if (next < 0 || next >= rows.length) return;
      const box = selected.getBoundingClientRect();
      const x = box.x + box.width / 2;
      select(rows[next].reduce((best, item) => {
        const distance = button => { const rect = button.getBoundingClientRect(); return Math.abs(rect.x + rect.width / 2 - x); };
        return distance(item) < distance(best) ? item : best;
      }));
    }
  }
  function setView(next, options = {}) {
    screen = next;
    dialog.dataset.view = next;
    layer.hidden = next === "home";
    home.inert = next !== "home";
    if (next === "home") home.removeAttribute("aria-hidden");
    else home.setAttribute("aria-hidden", "true");
    views.forEach(view => { byId(`${view}-view`).hidden = view !== next; });
    text("dialog-notice", "");
    if (options.title) text("dialog-title", options.title);
    if (options.description !== undefined) text("dialog-description", options.description);
    text("dialog-kicker", options.kicker || "Local saves");
    initialFocus(options.focus);
    previewScrollHint();
  }
  function homeAvailability() {
    const available = !busy && !externalBusy;
    byId("play").disabled = !available || !setup;
    byId("open-sync").disabled = !available || !status || !setup?.installed || !hasSupportedDirection();
    byId("open-cloud").disabled = !available || !setup?.installed;
    byId("options").disabled = busy || !setup;
    byId("exit").disabled = busy;
  }
  function directionSupport(direction) {
    if (status?.directionSupport) return status.directionSupport[direction] || {supported:false, reason:"This copy direction is unavailable."};
    return status?.saveSupport || {supported:true};
  }
  function hasSupportedDirection() {
    return ["steam-to-arm64", "arm64-to-steam"].some(direction => directionSupport(direction).supported !== false);
  }
  function updateSetup(value) {
    if (!value || typeof value.installed !== "boolean") throw new Error("The game setup could not be checked.");
    setup = value;
    text("play-title", value.installed ? "Play Alabaster Dawn" : "Install");
    byId("uninstall").disabled = !value.installed || busy || externalBusy;
    byId("add-to-steam").disabled = !value.installed || busy || externalBusy || typeof api().addToSteam !== "function";
    text("installed-path", value.installed ? value.gamePath || "Alabaster Dawn is installed." : "No game is installed in this launcher.");
    if (!value.installed) { status = null; text("save-status", "Ready to install"); }
    homeAvailability();
  }
  function updateStatus(value) {
    if (!value || typeof value !== "object") throw new Error("Local save status is unavailable.");
    status = value;
    externalBusy = Boolean(value.busy);
    const steam = count(value.steam?.count);
    const arm = count(value.arm64?.count);
    text("save-status", `Steam: ${files(steam)} · ARM64: ${files(arm)}`);
    if (!hasSupportedDirection()) {
      supportNotice = value.saveSupport?.reason || "Local save copying is unavailable for this setup.";
      text("home-notice", supportNotice);
    } else if (supportNotice) {
      if (byId("home-notice").textContent === supportNotice) text("home-notice", "");
      supportNotice = "";
    }
    renderSaves();
    homeAvailability();
  }
  async function refreshStatus() { updateStatus(await api().status()); }
  function setBusy(value) {
    busy = value;
    homeAvailability();
    if (status) updateStatus(status);
    dialog.setAttribute("aria-busy", String(value));
  }
  function busyView(title, detail) {
    setBusy(true);
    text("busy-message", detail);
    byId("operation-progress").hidden = true;
    setView("busy", {title, description: "Please keep the launcher open until this finishes."});
  }
  function renderSaves() {
    const destination = destinationSide();
    const support = directionSupport(copyDirection());
    const available = !busy && !externalBusy && support.supported !== false;
    dialog.querySelectorAll("[data-source]").forEach(button => button.setAttribute("aria-selected", String(button.dataset.source === sourceSide)));
    byId("save-source-panel").setAttribute("aria-labelledby", `tab-${sourceSide}`);
    text("viewing-source", `Viewing ${sideLabel(sourceSide)} saves`);
    const issues = new Map();
    dialog.querySelectorAll("[data-slot]").forEach(button => {
      const id = ["all", "auto"].includes(button.dataset.slot) ? button.dataset.slot : Number(button.dataset.slot);
      button.setAttribute("aria-pressed", String(selection === "all" ? id === "all" : selection.includes(id)));
      if (id === "all") {
        button.disabled = !available || !hasSourceSaves();
        button.title = button.disabled ? copyRestriction() : "All local saves, including the autosave";
      } else {
        const info = slotInfo(sourceSide, id);
        const dates = dateParts(info?.modified);
        const label = id === "auto" ? "Autosave" : `Slot ${id}`;
        const reason = info?.reason || "Save details could not be read.";
        const unavailable = reason === "Empty" ? "Empty" : reason === "Backup only; no current save." ? "Backup only" : "Unavailable";
        if (!info?.available && unavailable !== "Empty") {
          if (!issues.has(reason)) issues.set(reason, []);
          issues.get(reason).push(label);
        }
        button.disabled = !available || support.allOnly || !info?.available;
        button.classList.toggle("empty", !info?.available);
        button.querySelector(".slot-date").textContent = info?.available ? dates?.date || "Unknown" : unavailable;
        button.querySelector(".slot-time").textContent = info?.available ? dates?.time || "date" : "";
        button.title = !info?.available ? reason : support.allOnly ? copyRestriction() : dates?.full || "Saved date unavailable";
        button.setAttribute("aria-label", `${label}, ${info?.available ? dates?.full || "date unavailable" : `${unavailable}: ${reason}`}`);
      }
    });
    text("source-issues", Array.from(issues, ([reason, labels]) => `${labels.join(", ")}: ${reason}`).join(" · "));
    const ids = selectedIDs();
    text("selection-heading", selection === "all" ? "All saves" : ids.length ? `${ids.length} selected` : "No saves selected");
    text("selected-source-label", sideLabel(sourceSide));
    text("selected-destination-label", `Currently in ${sideLabel(destination)}`);
    dateRows(byId("selection-dates"), ids.map(id => ({id,
      source: dateLabel(slotInfo(sourceSide, id)?.modified, Boolean(slotInfo(sourceSide, id)?.available)),
      destination: dateLabel(slotInfo(destination, id)?.modified, Boolean(slotInfo(destination, id)?.available))})));
    text("slot-description", selection === "all" ? "All includes the autosave, manual slots, settings and backups." : ids.length ? "Only the selected saves will be copied. Other slots, settings and backups stay unchanged." : "Select Auto or one or more slots. All includes settings and backups too.");
    text("save-restriction", copyRestriction());
    text("copy-selected", selection === "all" ? `Copy all to ${sideLabel(destination)}` : `Copy selected (${ids.length}) to ${sideLabel(destination)}`);
    byId("copy-selected").disabled = !canCopySelection();
  }
  function showSync(focus = byId(`tab-${sourceSide}`)) {
    preview = null;
    renderSaves();
    setView("sync", {title:"Local saves", description:"Alabaster Dawn", focus});
  }
  function showSource(value) {
    if (busy || !["arm64", "steam"].includes(value)) return;
    if (sourceSide !== value) {
      sourceSide = value;
      selection = [];
      text("copy-error", "");
      renderSaves();
    }
    select(byId(`tab-${sourceSide}`));
  }
  function chooseSlot(value) {
    text("copy-error", "");
    if (value === "all") selection = selection === "all" ? [] : "all";
    else {
      const id = value === "auto" ? "auto" : Number(value);
      if ((id !== "auto" && (!Number.isInteger(id) || id < 1 || id > 10)) || !slotInfo(sourceSide, id)?.available) {
        text("copy-error", "This slot has no current save to copy.");
        return;
      }
      if (directionSupport(copyDirection()).allOnly) { text("copy-error", copyRestriction()); return; }
      const ids = selection === "all" ? [] : selection;
      selection = ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id].sort((a, b) => a === "auto" ? -1 : b === "auto" ? 1 : a - b);
    }
    renderSaves();
  }
  function copyError(value) {
    text("copy-error", value);
    // The error and action stay together; a rejection never returns to a hidden footer.
    byId("copy-error").closest(".save-action-area").scrollIntoView({block:"nearest", inline:"nearest", behavior:"instant"});
  }
  function showOptions() {
    uninstallPlan = null;
    byId("uninstall").disabled = !setup?.installed || externalBusy;
    byId("add-to-steam").disabled = !setup?.installed || externalBusy || typeof api().addToSteam !== "function";
    const supported = typeof api().uninstallPreview === "function" && typeof api().completeUninstall === "function";
    byId("complete-uninstall").disabled = busy || externalBusy || !supported;
    text("complete-uninstall-note", supported ? "" : "Complete uninstall is unavailable in this launcher version.");
    setView("options", {title: "Options", kicker: "Alabaster Dawn", description: "", focus: byId("add-to-steam")});
  }
  function steamNotice(result) {
    if (!result || result.skipped) return "";
    if (result.ok && result.installed)
      return [result.created ? "Added Alabaster Dawn ARM64 to Steam." : "Steam entry updated.", result.warning].filter(Boolean).join(" ");
    return `Steam entry not completed. ${result.warning || "Start Steam and retry from Options."}`;
  }
  async function addToSteam() {
    if (busy || !setup?.installed || typeof api().addToSteam !== "function") return;
    const token = ++operation;
    busyView("Steam library", "Adding to Steam…");
    try {
      const result = await api().addToSteam(progressFor(token));
      if (disposed || token !== operation) return;
      setBusy(false);
      showOptions();
      text("dialog-notice", steamNotice(result));
    } catch (error) {
      if (disposed || token !== operation) return;
      setBusy(false);
      showOptions();
      text("dialog-notice", `Steam entry not completed. ${message(error)}`);
    }
  }
  function showInstall() {
    byId("game-path").value = setup?.gamePath || setup?.defaultGamePath || "";
    text("install-detail", setup?.detail || "Choose the installed Alabaster Dawn or demo folder.");
    setView("install", {title: "Install Alabaster Dawn", kicker: "Game setup", description: "Select the existing Steam game files.", focus: byId("browse-game")});
  }
  function back() {
    if (busy) return;
    if (screen === "preview") {
      preview = null;
      showSync();
    } else if (screen === "cloud-preview") {
      cloudPreview = null;
      showCloud();
    } else if (["uninstall", "complete-preview", "controller"].includes(screen)) {
      showOptions();
    } else if (screen !== "home") {
      preview = null;
      const target = screen === "result" ? resultFocus : screen === "cloud" ? "open-cloud" : screen === "options" ? "options" : screen === "install" ? "play" : "open-sync";
      setView("home", {focus: byId(target)});
    }
  }

  function controllerName(type) {
    return ({"deck-uhid":"Steam Deck", "xb360":"Xbox 360", "ds5":"DualSense", "ds5-edge":"DualSense Edge", "xbox-series":"Xbox Series", "mixed":"Mixed modes", "none":"No active controller"})[type] || (typeof type === "string" && type ? type : "Unknown");
  }
  function controllerState(value) {
    if (!value || typeof value.available !== "boolean" || !Array.isArray(value.supported) ||
        !value.supported.every(type => typeof type === "string"))
      throw new Error("Controller state could not be verified. Reopen Controller emulation to check it.");
    return value;
  }
  function renderController(notice = "") {
    text("controller-configured", controllerName(controller?.configured));
    text("controller-live", controllerName(controller?.live));
    const available = controller?.available === true && !controller?.busy && !externalBusy;
    const info = [];
    if (externalBusy || controller?.busy) info.push(controller?.reason || "Close the game or finish the current operation before changing controller emulation.");
    else if (!available) info.push(controller?.reason || "Controller emulation is unavailable.");
    else if (!controller?.live) info.push("The live controller mode could not be verified.");
    else if (controller?.configured && controller.configured !== controller.live) info.push("Configured and live controller modes differ.");
    if (controller?.reason && available) info.push(controller.reason);
    if (notice) info.push(notice);
    text("controller-status", [...new Set(info)].join(" "));
    for (const button of byId("controller-view").querySelectorAll("[data-controller]")) {
      button.disabled = !available || !controller.supported.includes(button.dataset.controller);
      button.setAttribute("aria-pressed", String(button.dataset.controller === controllerChoice));
    }
    byId("controller-apply").disabled = !available || !controllerChoice || !controller.supported.includes(controllerChoice) ||
      (controller.configured === controllerChoice && controller.live === controllerChoice);
  }
  function showController({error = "", notice = "", focus = byId("controller-back")} = {}) {
    renderController(notice);
    text("controller-error", error);
    setView("controller", {title:"Controller emulation", kicker:"Armada", description:"", focus});
  }
  async function openController() {
    if (busy || screen !== "options") return;
    const token = ++operation;
    controller = null;
    controllerChoice = null;
    busyView("Controller emulation", "Reading the configured and live controller modes…");
    try {
      if (typeof api().controllerStatus !== "function" || typeof api().controllerSet !== "function")
        throw new Error("Controller emulation is unavailable in this launcher version.");
      controller = controllerState(await api().controllerStatus());
      if (disposed || token !== operation) return;
      setBusy(false);
      showController();
    } catch (error) {
      if (disposed || token !== operation) return;
      setBusy(false);
      showController({error:message(error)});
    }
  }
  function chooseController(type) {
    if (busy || screen !== "controller" || !["deck-uhid", "xb360"].includes(type)) return;
    controllerChoice = type;
    text("controller-error", "");
    renderController();
  }
  async function applyController() {
    if (busy || screen !== "controller" || byId("controller-apply").disabled) return;
    const type = controllerChoice;
    const token = ++operation;
    busyView("Changing controller emulation", "Approve the administrator prompt if requested. Controls may briefly reconnect…");
    try {
      const value = controllerState(await api().controllerSet(type));
      if (disposed || token !== operation) return;
      controller = value;
      if (controller.configured !== type || controller.live !== type) {
        const error = new Error("The requested mode was not verified for both configuration and live controllers.");
        error.state = controller;
        error.uncertain = true;
        throw error;
      }
      controllerChoice = null;
      setBusy(false);
      showController({notice:`${controllerName(type)} is configured and active.`});
    } catch (error) {
      if (disposed || token !== operation) return;
      try { controller = error.state ? controllerState(error.state) : null; } catch { controller = null; }
      setBusy(false);
      showController({error:message(error) + (error.uncertain ? " The change may have partly applied. Check the live mode before retrying." : "")});
    }
  }

  function cloudAPI() {
    const value = api();
    if (["cloudStatus", "cloudPreview", "cloudSync"].some(key => typeof value[key] !== "function")) {
      throw new Error("Cloud sync is unavailable in this launcher build.");
    }
    return value;
  }
  function progressFor(token) {
    return value => {
      if (disposed || token !== operation) return;
      const detail = typeof value === "string" ? value : value?.message;
      if (typeof detail === "string") text("busy-message", detail.slice(0, 800));
      const percent = value?.percent;
      byId("operation-progress").hidden = !Number.isFinite(percent);
      if (Number.isFinite(percent)) byId("operation-progress").value = Math.max(0, Math.min(100, percent));
    };
  }
  function showCloud(error = "") {
    cloudPreview = null;
    const available = cloud?.available === true && !cloud?.busy && !externalBusy;
    text("cloud-status", externalBusy || cloud?.busy ? "Close the game or finish the current operation before syncing." : available ? "Steam login ready" : cloud?.reason || "Steam login required. Sign in to Steam, then reopen Cloud sync.");
    text("cloud-account", available && cloud.accountId ? `Steam account: ${cloud.accountId}` : "");
    const last = typeof cloud?.lastSync === "object" ? cloud.lastSync?.date : cloud?.lastSync;
    text("cloud-last-sync", dateParts(last) ? `Last sync: ${dateLabel(last)}` : "");
    text("cloud-error", error);
    byId("cloud-download").disabled = !available;
    byId("cloud-upload").disabled = !available;
    setView("cloud", {title:"Cloud sync", kicker:"Steam Cloud", description:"Manual sync using the existing Steam login.", focus:byId(available ? `cloud-${cloudDirection}` : "cloud-back")});
    if (error) byId("cloud-error").scrollIntoView({block:"nearest", inline:"nearest", behavior:"instant"});
  }
  async function openCloud() {
    if (busy) return;
    resultFocus = "open-cloud";
    cloudDirection = "download";
    cloud = null;
    cloudPreview = null;
    const token = ++operation;
    busyView("Cloud sync", "Checking the Steam login…");
    text("dialog-kicker", "Steam Cloud");
    try {
      const value = await cloudAPI().cloudStatus();
      if (disposed || token !== operation) return;
      if (!value || typeof value.available !== "boolean") throw new Error("Steam Cloud status could not be read.");
      cloud = value;
      setBusy(false);
      showCloud();
    } catch (error) {
      if (disposed || token !== operation) return;
      cloud = {available:false, reason:message(error)};
      setBusy(false);
      showCloud();
    }
  }
  async function prepareCloud(direction) {
    if (busy || screen !== "cloud" || !["download", "upload"].includes(direction)) return;
    if (!cloud?.available || cloud?.busy || externalBusy) { showCloud("Steam Cloud is not ready. Check the status above."); return; }
    cloudDirection = direction;
    cloudPreview = null;
    const token = ++operation;
    busyView("Review Cloud sync", "Refreshing Steam Cloud into the Steam save folder…");
    text("dialog-kicker", "Steam Cloud");
    text("dialog-description", "ARM64 saves have not changed. Keep the launcher open while Steam saves are refreshed.");
    try {
      const value = await cloudAPI().cloudPreview(direction, progressFor(token));
      if (disposed || token !== operation) return;
      if (!value || typeof value.token !== "string" || !value.token || value.direction !== direction || count(value.fileCount) === null || count(value.changedCount) === null || typeof value.sourceLabel !== "string" || typeof value.destinationLabel !== "string" || typeof value.unchanged !== "boolean") {
        throw new Error("The Cloud preview is incomplete. No ARM64 save copy was confirmed.");
      }
      cloudPreview = {token:value.token, direction, unchanged:value.unchanged, fileCount:value.fileCount};
      text("cloud-source-label", value.sourceLabel);
      text("cloud-destination-label", value.destinationLabel);
      text("cloud-source-date", value.sourceDate ? dateLabel(value.sourceDate) : "No saved date");
      text("cloud-destination-date", value.pendingUpload ? "Cloud date unavailable while local changes are pending" : value.destinationDate ? dateLabel(value.destinationDate) : "No saved date");
      text("cloud-file-count", `${files(value.fileCount)} in the complete save set · ${value.changedCount} changed`);
      text("cloud-overwrite-warning", value.unchanged ? "These save sets already match. No copy is needed." : direction === "download" ? "The complete ARM64 save set will be replaced by Steam Cloud saves. A local backup is created first." : "ARM64 saves will replace the matching Steam Cloud saves. Existing local destination files are backed up first.");
      text("cloud-preview-warning", typeof value.warning === "string" ? value.warning.slice(0, 800) : "");
      text("confirm-cloud", direction === "download" ? "Confirm download" : "Confirm upload");
      byId("confirm-cloud").disabled = value.unchanged || value.fileCount === 0;
      setBusy(false);
      setView("cloud-preview", {title:value.unchanged ? "Cloud saves already match" : direction === "download" ? "Download to ARM64?" : "Upload ARM64 saves?", kicker:"Steam Cloud", description:"Review the saved dates before confirming.", focus:byId("cancel-cloud")});
    } catch (error) {
      if (disposed || token !== operation) return;
      setBusy(false);
      showCloud(message(error));
    }
  }
  async function confirmCloud() {
    if (busy || screen !== "cloud-preview" || !cloudPreview || cloudPreview.unchanged || !cloudPreview.fileCount) return;
    const requested = cloudPreview;
    cloudPreview = null;
    const token = ++operation;
    busyView(requested.direction === "download" ? "Downloading saves" : "Uploading saves", "Rechecking the save sets before copying…");
    text("dialog-kicker", "Steam Cloud");
    try {
      const result = await cloudAPI().cloudSync(requested.token, progressFor(token));
      if (disposed || token !== operation) return;
      if (!result || typeof result.message !== "string") throw new Error("Cloud sync returned no readable result. Check Steam Cloud and the local saves before trying again.");
      const backups = Array.isArray(result.backupPaths) ? result.backupPaths.filter(path => typeof path === "string" && path) : [];
      setBusy(false);
      setView("result", {title:"Cloud sync complete", kicker:"Steam Cloud", description:"No automatic sync is enabled.", focus:byId("result-done")});
      text("result-summary", result.message.slice(0, 800));
      byId("backup-details").hidden = !backups.length;
      text("backup-value", backups.join("\n"));
      try { await refreshStatus(); } catch { text("dialog-notice", "Cloud sync completed, but local save counts could not be refreshed."); }
    } catch (error) {
      if (disposed || token !== operation) return;
      setBusy(false);
      showCloud(message(error));
    }
  }

  async function openSync() {
    if (busy) return;
    const token = ++operation;
    resultFocus = "open-sync";
    sourceSide = "arm64";
    selection = [];
    text("copy-error", "");
    busyView("Local saves", "Checking local saves…");
    try {
      await refreshStatus();
      if (disposed || token !== operation) return;
      setBusy(false);
      showSync();
      if (externalBusy) copyError("Close the game before copying local saves.");
    } catch (error) {
      if (disposed || token !== operation) return;
      setBusy(false);
      setView("result", {title: "Couldn’t check saves", description: "No files were copied.", focus: byId("result-done")});
      text("result-summary", message(error));
      byId("backup-details").hidden = true;
    }
  }

  async function prepareCopy() {
    if (!canCopySelection()) {
      copyError(copyRestriction() || (busy ? "The current operation is still running." : "Select at least one saved slot or All."));
      return;
    }
    const direction = copyDirection();
    const requested = selection === "all" ? "all" : [...selection];
    const token = ++operation;
    preview = null;
    text("copy-error", "");
    busyView("Review save copy", "Checking the selected saves…");
    try {
      const value = await api().preview(direction, requested);
      if (disposed || token !== operation) return;
      const sourceCount = count(value?.sourceCount);
      const destinationCount = count(value?.destinationCount);
      if (sourceCount === null || destinationCount === null || typeof value.sourceLabel !== "string" || typeof value.destinationLabel !== "string" || !Array.isArray(value.entries)) {
        throw new Error("The save-copy preview is incomplete. No files were copied.");
      }
      preview = {direction, selection:requested, sourceCount, destinationCount};
      text("source-label", `From ${value.sourceLabel}`);
      text("destination-label", `Currently in ${value.destinationLabel}`);
      text("preview-selection-label", requested === "all" ? "All saves" : `${requested.length} selected`);
      dateRows(byId("preview-entries"), value.entries.map(item => ({id:item.id,
        source:dateLabel(item.sourceModified), destination:item.destinationModified ? dateLabel(item.destinationModified) : "Empty"})));
      text("copy-scope", typeof value.preservationNote === "string" ? value.preservationNote : requested === "all" ? "Includes the autosave, settings and backups. Source saves are kept." : "Other slots, the autosave, settings and existing backups are kept.");
      text("overwrite-warning", sourceCount === 0 ? "There are no source saves to copy." : value.overwriteCount > 0 || value.entries.some(item => item.changed && item.destinationModified)
        ? "Existing destination saves will be replaced. A backup is created first."
        : "The selected saves will be copied. Source saves are kept.");
      setBusy(false);
      byId("confirm-copy").disabled = sourceCount === 0;
      text("confirm-copy", requested === "all" ? "Copy all saves" : requested.length === 1 ? requested[0] === "auto" ? "Copy autosave" : `Copy slot ${requested[0]}` : `Copy selected (${requested.length})`);
      setView("preview", {title:requested === "all" ? `Copy all saves to ${value.destinationLabel}?` : requested.length === 1 ? `Copy ${requested[0] === "auto" ? "autosave" : `slot ${requested[0]}`} to ${value.destinationLabel}?` : `Copy selected (${requested.length}) to ${value.destinationLabel}?`, description:"", focus:byId("cancel-copy")});
    } catch (error) {
      if (disposed || token !== operation) return;
      setBusy(false);
      showSync(byId("copy-selected"));
      copyError(message(error));
    }
  }

  async function confirmCopy() {
    if (busy || screen !== "preview" || !preview || preview.sourceCount === 0) return;
    const {direction, selection} = preview;
    preview = null;
    const token = ++operation;
    busyView("Copying local saves", "Copying saves and preparing the destination…");
    try {
      const result = await api().sync(direction, selection);
      if (disposed || token !== operation) return;
      const copied = count(result?.copied);
      if (copied === null) throw new Error("The copy finished without a readable result. Check the local saves before trying again.");
      const hasBackup = typeof result.backup === "string" && result.backup.length > 0;
      const unchanged = copied === 0 && !hasBackup;
      setBusy(false);
      setView("result", {title: unchanged ? "Saves already match" : "Local saves copied", description: unchanged ? "No overwrite was needed." : "The source saves have been kept.", focus: byId("result-done")});
      text("result-summary", unchanged ? "Your local saves are already up to date." : `${files(copied)} copied successfully.`);
      byId("backup-details").hidden = unchanged;
      text("backup-value", hasBackup ? result.backup : "No destination backup was needed.");
      try { await refreshStatus(); } catch { text("dialog-notice", "The copy completed, but the save counts could not be refreshed."); }
    } catch (error) {
      if (disposed || token !== operation) return;
      setBusy(false);
      setView("result", {title: "Copy wasn’t completed", description: "Check the result before trying again.", focus: byId("result-done")});
      text("result-summary", message(error));
      byId("backup-details").hidden = true;
    }
  }

  async function browseGame() {
    if (busy || screen !== "install") return;
    setBusy(true);
    text("dialog-notice", "");
    try {
      const folder = await api().browseGame();
      if (typeof folder === "string" && folder) byId("game-path").value = folder;
    } catch (error) { text("dialog-notice", message(error)); }
    finally { if (!disposed) { setBusy(false); initialFocus(byId("confirm-install")); } }
  }

  async function installGame() {
    if (busy || screen !== "install") return;
    const folder = byId("game-path").value.trim();
    if (!folder) { text("dialog-notice", "Choose the Steam game folder first."); return; }
    const token = ++operation;
    resultFocus = "play";
    busyView("Installing", "Checking the game files…");
    try {
      const result = await api().install(folder, value => {
        if (disposed || token !== operation) return;
        const detail = typeof value === "string" ? value : value?.message;
        if (typeof detail === "string") text("busy-message", detail.slice(0, 800));
        const percent = value?.percent;
        byId("operation-progress").hidden = !Number.isFinite(percent);
        if (Number.isFinite(percent)) byId("operation-progress").value = Math.max(0, Math.min(100, percent));
      });
      if (disposed || token !== operation) return;
      updateSetup(await api().setupStatus());
      if (!setup.installed) throw new Error("Installation did not complete. Check the selected game folder.");
      setBusy(false);
      setView("home", {focus: byId("play")});
      const notice = ["Installation complete.", steamNotice(result?.steamShortcut)].filter(Boolean).join(" ");
      text("home-notice", notice);
      try { await refreshStatus(); } catch (error) { text("home-notice", `${notice} ${message(error)}`); }
    } catch (error) {
      if (disposed || token !== operation) return;
      setBusy(false);
      showInstall();
      byId("game-path").value = folder;
      text("dialog-notice", message(error));
    }
  }

  async function uninstallGame() {
    if (busy || screen !== "uninstall") return;
    const token = ++operation;
    resultFocus = "play";
    busyView("Disconnecting game files", "Removing this launcher’s game-file connection…");
    try {
      await api().uninstall();
      if (disposed || token !== operation) return;
      updateSetup(await api().setupStatus());
      if (setup.installed) throw new Error("The game files are still connected. Disconnect did not complete.");
      setBusy(false);
      setView("home", {focus: byId("play")});
      text("home-notice", "Game files disconnected. The launcher, runtime, shortcuts and saved progress were kept.");
    } catch (error) {
      if (disposed || token !== operation) return;
      setBusy(false);
      showOptions();
      text("dialog-notice", message(error));
    }
  }

  async function prepareCompleteUninstall() {
    if (busy || screen !== "options" || externalBusy) return;
    const token = ++operation;
    uninstallPlan = null;
    busyView("Review complete uninstall", "Checking this launcher installation…");
    try {
      if (typeof api().uninstallPreview !== "function" || typeof api().completeUninstall !== "function")
        throw new Error("Complete uninstall is unavailable in this launcher version.");
      const value = await api().uninstallPreview();
      if (disposed || token !== operation) return;
      if (!value || typeof value.root !== "string" || !value.root.startsWith("/") ||
          !Array.isArray(value.removePaths) || !value.removePaths.every(item => typeof item === "string") ||
          !Array.isArray(value.preservedPaths) || !value.preservedPaths.every(item => typeof item === "string") ||
          !Array.isArray(value.warnings) || !value.warnings.every(item => typeof item === "string"))
        throw new Error("The uninstall preview is incomplete. Nothing was removed.");
      uninstallPlan = value;
      text("complete-installation-root", value.root);
      text("complete-warnings", value.warnings.join("\n"));
      byId("complete-warnings").hidden = !value.warnings.length;
      byId("complete-warnings").scrollTop = 0;
      setBusy(false);
      setView("complete-preview", {title:"Completely uninstall?", kicker:"This launcher only", description:"", focus:byId("cancel-complete")});
    } catch (error) {
      if (disposed || token !== operation) return;
      setBusy(false);
      showOptions();
      text("dialog-notice", message(error));
    }
  }
  async function completeUninstall() {
    if (busy || screen !== "complete-preview" || !uninstallPlan) return;
    uninstallPlan = null;
    const token = ++operation;
    busyView("Uninstalling this launcher", "Removing the launcher, runtime and its shortcuts. Saved progress is kept.");
    try {
      const result = await api().completeUninstall();
      if (disposed || token !== operation) return;
      if (!result || result.ok !== true) throw new Error(result?.message || "Complete uninstall did not finish. Check the installation before trying again.");
      // The backend closes NW.js after a successful removal. Keep deleted-app
      // actions locked while that handoff finishes.
      text("busy-message", "Uninstall complete. Closing the launcher…");
    } catch (error) {
      if (disposed || token !== operation) return;
      const failure = message(error);
      try { updateSetup(await api().setupStatus()); } catch { setup = null; }
      setBusy(false);
      showOptions();
      text("dialog-notice", failure);
    }
  }

  async function launchOrExit(action) {
    if (busy || screen !== "home" || (action === "play" && externalBusy)) return;
    if (action === "play" && !setup?.installed) { showInstall(); return; }
    setBusy(true);
    text("home-notice", action === "play" ? "Opening Alabaster Dawn…" : "Closing…");
    try {
      await api()[action]();
      // A successful handoff keeps the menu locked until it is hidden or closed.
    } catch (error) {
      setBusy(false);
      text("home-notice", message(error));
      initialFocus(byId(action));
    }
  }

  document.addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled || busy || !buttons().includes(button)) return;
    select(button, false);
    switch (button.dataset.action) {
      case "play": case "exit": void launchOrExit(button.dataset.action); break;
      case "open-sync": void openSync(); break;
      case "open-cloud": void openCloud(); break;
      case "cloud-preview": void prepareCloud(button.dataset.direction); break;
      case "confirm-cloud": void confirmCloud(); break;
      case "cancel-cloud": cloudPreview = null; showCloud(); break;
      case "slot": chooseSlot(button.dataset.slot); break;
      case "source": showSource(button.dataset.source); break;
      case "options": showOptions(); break;
      case "add-to-steam": void addToSteam(); break;
      case "open-controller": void openController(); break;
      case "controller-choice": chooseController(button.dataset.controller); break;
      case "controller-apply": void applyController(); break;
      case "browse": void browseGame(); break;
      case "install": void installGame(); break;
      case "uninstall": setView("uninstall", {title: "Disconnect game files?", kicker: "Game setup", description: "", focus: byId("cancel-uninstall")}); break;
      case "cancel-uninstall": showOptions(); break;
      case "confirm-uninstall": void uninstallGame(); break;
      case "complete-preview": void prepareCompleteUninstall(); break;
      case "cancel-complete": showOptions(); break;
      case "confirm-complete": void completeUninstall(); break;
      case "preview": void prepareCopy(); break;
      case "confirm": void confirmCopy(); break;
      case "cancel": case "back": case "done": back(); break;
    }
  });
  document.addEventListener("pointerdown", () => {
    inputMode = "pointer";
    document.querySelectorAll(".is-selected").forEach(item => item.classList.remove("is-selected"));
  });
  document.addEventListener("focusin", event => {
    if (event.target.matches("button[data-action]") && buttons().includes(event.target)) select(event.target, false);
  });
  document.addEventListener("keydown", event => {
    if (event.ctrlKey && event.key === "Tab" && screen === "sync") {
      event.preventDefault();
      if (!event.repeat && !busy) showSource(destinationSide());
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target.matches("input") && !["Escape", "Tab"].includes(event.key)) return;
    if (["preview", "complete-preview"].includes(screen) && ["PageUp", "PageDown"].includes(event.key)) {
      event.preventDefault();
      if (!busy) scrollReview(event.key === "PageUp" ? -1 : 1, true);
      return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "Escape", "Tab"].includes(event.key)) return;
    event.preventDefault();
    inputMode = "keyboard";
    if (event.key === "Escape") { if (!event.repeat) back(); return; }
    if (busy) return;
    if (event.key === "Tab") { move(event.shiftKey ? -1 : 1); return; }
    if (event.key.startsWith("Arrow")) { navigate(event.key); return; }
    if (event.repeat) return;
    const available = buttons();
    if (!available.includes(selected)) initialFocus();
    if (selected && !selected.disabled) selected.click();
  });

  // Standard Gamepad mapping: A=0, B=1, d-pad=12..15, left stick=0/1.
  // Chromium may expose a pad only when A is first pressed. Accept that press
  // on Home; keep edge history across views and seed new pads in submenus.
  let padHistory = new Map();
  let navigationDirection = 0;
  let nextNavigation = 0;
  let animation = 0;
  let focused = document.hasFocus();
  function resetPads() { padHistory = new Map(); navigationDirection = 0; nextNavigation = 0; }
  function pollPads(now) {
    if (disposed) return;
    animation = requestAnimationFrame(pollPads);
    if (document.hidden || !focused) { resetPads(); return; }
    let pads;
    try { pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : []; } catch { return; }
    const connected = new Set();
    let direction = 0;
    let activated = false;
    for (const pad of pads) {
      if (!pad || !pad.connected || pad.mapping !== "standard") continue;
      connected.add(pad.index);
      const pressed = index => Boolean(pad.buttons[index]?.pressed);
      const state = {a: pressed(0), b: pressed(1), lb:pressed(4), rb:pressed(5), id: pad.id};
      const known = padHistory.get(pad.index);
      const previous = known?.id === state.id ? known : screen === "home" ? {a:false,b:false,lb:false,rb:false,id:state.id} : state;
      padHistory.set(pad.index, state);
      if (!activated && !busy && screen === "sync" && ((state.lb && !previous.lb) || (state.rb && !previous.rb))) {
        inputMode = "gamepad";
        showSource(destinationSide());
        activated = true;
      } else if (!activated && !busy && state.b && !previous.b) {
        inputMode = "gamepad";
        back();
        activated = true;
      } else if (!activated && !busy && state.a && !previous.a) {
        inputMode = "gamepad";
        if (!buttons().includes(selected)) initialFocus();
        selected?.click();
        activated = true;
      }
      if (!direction) {
        const x = Number.isFinite(pad.axes[0]) ? pad.axes[0] : 0;
        const y = Number.isFinite(pad.axes[1]) ? pad.axes[1] : 0;
        if (pressed(12) || y < -.6) direction = "ArrowUp";
        else if (pressed(13) || y > .6) direction = "ArrowDown";
        else if (pressed(14) || x < -.6) direction = "ArrowLeft";
        else if (pressed(15) || x > .6) direction = "ArrowRight";
      }
    }
    for (const index of padHistory.keys()) if (!connected.has(index)) padHistory.delete(index);
    if (!direction || busy || activated) { navigationDirection = 0; return; }
    if (direction !== navigationDirection || now >= nextNavigation) {
      navigate(direction);
      nextNavigation = now + (direction !== navigationDirection ? 360 : 160);
      navigationDirection = direction;
    }
  }
  window.addEventListener("resize", previewScrollHint);
  window.addEventListener("blur", () => { focused = false; resetPads(); });
  window.addEventListener("focus", () => { focused = true; resetPads(); });
  document.addEventListener("visibilitychange", resetPads);
  window.addEventListener("pagehide", () => { disposed = true; ++operation; cancelAnimationFrame(animation); });

  const logo = byId("game-logo");
  function logoFallback() { logo.hidden = true; byId("logo-fallback").hidden = false; }
  logo.addEventListener("error", logoFallback);
  if (logo.complete && logo.naturalWidth === 0) logoFallback();
  animation = requestAnimationFrame(pollPads);
  (async () => {
    let setupNotice = "";
    try {
      api();
      setBusy(true);
      updateSetup(await api().setupStatus());
      if (setup.installed && typeof api().finishSetup === "function") {
        const result = await api().finishSetup(() => {
          if (!disposed) busyView("Steam library", "Adding to Steam…");
        });
        if (disposed) return;
        setupNotice = steamNotice(result);
      }
      setBusy(false);
      setView("home", {focus: byId("play")});
      if (setup.installed) await refreshStatus();
      if (disposed) return;
      if (setupNotice) text("home-notice", setupNotice);
      if (externalBusy) text("home-notice", "Another operation is in progress. Please wait.");
      initialFocus(byId("play"));
    } catch (error) {
      text("save-status", "Local saves unavailable");
      text("home-notice", [setupNotice, message(error)].filter(Boolean).join(" "));
      // A save-status failure does not prevent launching the game or exiting.
      try {
        api();
        status = null;
        externalBusy = false;
        setBusy(false);
        setView("home", {focus: byId("play")});
        initialFocus(byId("play"));
      } catch { /* No backend operation can be invoked. */ }
    }
  })();
})();
