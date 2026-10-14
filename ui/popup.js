/* Toolbar popup: same card as the floating orb, pointed at the tab you're on. */
"use strict";
CapsaCard.mount(document.getElementById("app"), {
  mode: "popup",
  getTabId: async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && tab.id;
  },
});
