// По клику на иконку расширения открываем боковую панель (без popup)
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});
