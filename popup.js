document.getElementById('extract').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = 'Извлечение...';
  status.className = '';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      status.textContent = 'Не удалось получить активную вкладку';
      status.className = 'error';
      return;
    }

    // Внедряем content script и получаем текст
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const title = document.title || 'Без названия';
        const text = document.body ? document.body.innerText : '';
        return { title, text };
      }
    });

    if (!results?.[0]?.result) {
      status.textContent = 'Не удалось прочитать страницу (возможно, это chrome://)';
      status.className = 'error';
      return;
    }

    const { title, text } = results[0].result;

    await chrome.storage.session.set({
      pageExtractedTitle: title,
      pageExtractedText: text,
      pageExtractedUrl: tab.url || ''
    });

    await chrome.sidePanel.open({ windowId: tab.windowId });
    status.textContent = 'Готово!';
    status.className = 'success';
  } catch (err) {
    status.textContent = 'Ошибка: ' + (err.message || 'неизвестная');
    status.className = 'error';
  }
});
