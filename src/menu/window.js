(() => {
  "use strict";
  if (typeof nw !== "undefined" && nw.Window?.get) {
    let applied = false;
    function windowError(message) {
      console.error("Launcher window could not be maximized:", message);
      try { nw.Window.get().show(); }
      catch (error) { console.error("Launcher window could not be shown:", error); }
    }
    function maximizeMenu() {
      if (applied) return;
      applied = true;
      try {
        // Use the browser's current window, then request visibility and state
        // together. NW's individual show/maximize methods do not await replies.
        chrome.windows.getCurrent({}, current => {
          const lookupError = chrome.runtime.lastError;
          if (lookupError || !Number.isInteger(current?.id)) {
            windowError(lookupError?.message || "The native window was not available.");
            return;
          }
          chrome.windows.update(current.id, {show: true, state: "maximized", focused: true}, () => {
            const updateError = chrome.runtime.lastError;
            if (updateError) windowError(updateError.message);
          });
        });
      } catch (error) { windowError(error.message || String(error)); }
    }
    if (document.readyState === "complete") maximizeMenu();
    else window.addEventListener("load", maximizeMenu, {once: true});
  }
})();
