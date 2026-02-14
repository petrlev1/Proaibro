const STORAGE_KEYS = ['pageExtractedTitle', 'pageExtractedText', 'pageExtractedUrl', 'pageSummary'];

function getEl(id) {
  return document.getElementById(id);
}

let apiKey = null;

async function loadApiKey() {
  try {
    const response = await fetch(chrome.runtime.getURL('Settings.json'));
    const settings = await response.json();
    apiKey = settings.openrouter_api_key;
  } catch (err) {
    console.error('Failed to load API key:', err);
    return null;
  }
}

async function sendQueryToModel(text, userQuery) {
  if (!apiKey) {
    await loadApiKey();
    if (!apiKey) {
      throw new Error('API ключ не найден');
    }
  }

  const userContent = `${userQuery.trim()}\n\nТекст:\n${text.substring(0, 50000)}`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': chrome.runtime.getURL('viewer.html'),
      'X-Title': 'Text Extractor Extension'
    },
    body: JSON.stringify({
      model: 'qwen/qwen3-30b-a3b-thinking-2507',
      messages: [
        {
          role: 'system',
          content: 'Ты помощник. Выполняй запрос пользователя относительно приведённого текста. Отвечай на русском языке по существу запроса.'
        },
        {
          role: 'user',
          content: userContent
        }
      ],
      temperature: 0.7,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || 'Нет ответа от модели';
}

async function loadFromStorage() {
  const data = await chrome.storage.session.get(STORAGE_KEYS);
  getEl('textContent').textContent = data.pageExtractedText || '';
  
  if (data.pageSummary) {
    getEl('summaryContent').textContent = data.pageSummary;
    getEl('summarySection').style.display = 'block';
  } else {
    getEl('summarySection').style.display = 'none';
  }
}

document.getElementById('sendBtn').addEventListener('click', async () => {
  const btn = getEl('sendBtn');
  const queryInput = getEl('queryInput');
  const userQuery = queryInput.value.trim();

  if (!userQuery) {
    queryInput.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Обработка...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      btn.textContent = 'Ошибка: нет вкладки';
      btn.disabled = false;
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const title = document.title || 'Без названия';
        const text = document.body ? document.body.innerText : '';
        return { title, text };
      }
    });

    if (!results?.[0]?.result) {
      btn.textContent = 'Не удалось прочитать страницу (chrome://?)';
      btn.disabled = false;
      return;
    }

    const { title, text } = results[0].result;

    if (!text || text.trim().length === 0) {
      btn.textContent = 'Данных пока нет';
      btn.disabled = false;
      return;
    }

    await chrome.storage.session.set({
      pageExtractedTitle: title,
      pageExtractedText: text,
      pageExtractedUrl: tab.url || ''
    });

    await loadFromStorage();

    getEl('summarySection').style.display = 'block';
    getEl('summaryLoading').style.display = 'block';
    getEl('summaryContent').textContent = '';

    try {
      const response = await sendQueryToModel(text, userQuery);
      await chrome.storage.session.set({ pageSummary: response });
      getEl('summaryContent').textContent = response;
    } catch (err) {
      console.error('Query failed:', err);
      getEl('summaryContent').textContent = `Ошибка: ${err.message}`;
    }
    getEl('summaryLoading').style.display = 'none';
    btn.textContent = 'Отправить запрос';
  } catch (err) {
    btn.textContent = 'Отправить запрос';
  }
  btn.disabled = false;
});


// Загружаем API ключ при загрузке страницы
loadApiKey();
loadFromStorage();
