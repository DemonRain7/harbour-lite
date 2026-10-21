"use strict";

// autoHideMenuBar only conceals the menu: a bare Alt still reveals it and
// resizes the content. These windows have their own controls. Keep macOS's
// application menu (and standard editing accelerators) untouched.
function removeWindowMenu(win, platform = process.platform) {
  if (platform !== "darwin") win.removeMenu();
}

module.exports = { removeWindowMenu };
