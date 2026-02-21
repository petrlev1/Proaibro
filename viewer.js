const STORAGE_KEYS = ['pageExtractedTitle', 'pageExtractedText', 'pageExtractedUrl'];
const CHATS_KEY = 'proaibro_chats';
const CHAT_ORDER_KEY = 'proaibro_chat_order';
const PRIVATE_CHAT_KEY = 'proaibro_private_messages';
const PRIVATE_MODE_KEY = 'proaibro_private_mode';
const AGENT_MODE_KEY = 'proaibro_agent_mode';
const SCREENSHOT_MAX_SIDE = 1024;
const SCREENSHOT_JPEG_QUALITY = 0.6;
const SCREENSHOT_MAX_CHARS = 120000; // защита от переполнения промпта

function getEl(id) {
  return document.getElementById(id);
}

let apiKey = null;
let currentChatId = null;
let isPrivateMode = false;
let isAgentMode = false;

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

async function loadAgentModeFlag() {
  const session = await chrome.storage.session.get([AGENT_MODE_KEY]);
  isAgentMode = Boolean(session[AGENT_MODE_KEY]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function captureTabScreenshot() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
    return dataUrl || null;
  } catch (err) {
    console.warn('captureVisibleTab failed', err);
    return null;
  }
}

async function compressDataUrlPngToJpeg(dataUrl, maxSide = SCREENSHOT_MAX_SIDE, quality = SCREENSHOT_JPEG_QUALITY) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const { width, height } = img;
        const scale = Math.min(1, maxSide / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const jpegUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(jpegUrl);
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function getCompressedScreenshotDataUrl() {
  const raw = await captureTabScreenshot();
  if (!raw) return null;
  try {
    const jpeg = await compressDataUrlPngToJpeg(raw);
    return jpeg;
  } catch (err) {
    console.warn('compress screenshot failed, using raw', err);
    return raw;
  }
}

function createChatId() {
  return 'chat-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

async function getChats() {
  const r = await chrome.storage.local.get([CHATS_KEY]);
  return r[CHATS_KEY] || {};
}

async function getChatOrder() {
  const r = await chrome.storage.local.get([CHAT_ORDER_KEY]);
  return r[CHAT_ORDER_KEY] || [];
}

async function saveChatToLocal(chatId, chat) {
  const chats = await getChats();
  chats[chatId] = chat;
  await chrome.storage.local.set({ [CHATS_KEY]: chats });
  const order = await getChatOrder();
  if (!order.includes(chatId)) {
    order.unshift(chatId);
    await chrome.storage.local.set({ [CHAT_ORDER_KEY]: order });
  }
}

async function appendMessageToLocalChat(chatId, role, content, titleSnippet) {
  const chats = await getChats();
  let chat = chats[chatId];
  if (!chat) {
    chat = { id: chatId, createdAt: Date.now(), title: titleSnippet || 'Новый чат', messages: [] };
  }
  chat.messages.push({ role, content, timestamp: Date.now() });
  if (titleSnippet && !chat.title) chat.title = titleSnippet;
  chats[chatId] = chat;
  await chrome.storage.local.set({ [CHATS_KEY]: chats });
  let order = await getChatOrder();
  if (!order.includes(chatId)) {
    order.unshift(chatId);
    await chrome.storage.local.set({ [CHAT_ORDER_KEY]: order });
  }
}

async function getPrivateMessages() {
  const r = await chrome.storage.session.get([PRIVATE_CHAT_KEY]);
  return r[PRIVATE_CHAT_KEY] || [];
}

async function appendPrivateMessage(role, content) {
  const messages = await getPrivateMessages();
  messages.push({ role, content, timestamp: Date.now() });
  await chrome.storage.session.set({ [PRIVATE_CHAT_KEY]: messages });
}

async function sendQueryToModel(text, userQuery, agentMode, screenshotDataUrl) {
  if (!apiKey) {
    await loadApiKey();
    if (!apiKey) throw new Error('API ключ не найден');
  }
  const pageText = (text || '').substring(0, 50000);
  const hasTextContent = pageText.trim().length > 0;
  const hasScreenshot = Boolean(screenshotDataUrl);
  const screenshotInfo = hasScreenshot ? 'Скриншот приложен (JPEG data URL).' : 'Скриншот недоступен или не смог быть снят.';
  const textInfo = hasTextContent ? 'Текст страницы получен.' : 'Текст страницы отсутствует или пуст.';

  const systemPrompt = `Ты помощник. Тебе даётся запрос пользователя, текст открытой страницы и (если есть) скриншот страницы.

Правила ответа:
1. Если ответ на запрос пользователя ЕСТЬ в тексте страницы или на скриншоте — опирайся на эти данные.
2. Если нужной информации нет или её недостаточно — ответь из своих знаний.
3. Если текста нет, опирайся только на скриншот. Если нет ни текста, ни скриншота — отвечай из общих знаний.

Если РЕЖИМ АГЕНТА ВЫКЛЮЧЕН: дай только текстовый ответ.

Если РЕЖИМ АГЕНТА ВКЛЮЧЕН: дай ДВА блока:
— Краткий план действий (2–5 шагов)
— JSON вида {"actions":[{"type":"input","selector":"CSS","value":"..."},{"type":"click","selector":"CSS"}]}
   * Поддерживаемые type: "input" (ввод текста), "click" (клик мышью), "move" (подвести курсор к элементу для наведения/hover), "wait" (пауза в миллисекундах).
   * Для input/click/move обязателен selector (CSS). Дай наиболее узкий селектор.
   * Для click можно указать button: "left" | "right" | "middle" (по умолчанию left).
   * Для wait укажи поле ms (0–4000).
   * Не больше 10 действий. Если выполнить нельзя — actions: [].

Отвечай на русском языке.`;

  const userText = `Режим агента: ${agentMode ? 'ВКЛ' : 'ВЫКЛ'}
Запрос пользователя: ${userQuery.trim()}
${textInfo}
${screenshotInfo}

Текст открытой страницы (если пустой — опирайся на скриншот или отвечай из знаний):
---
${pageText}
---`;

  const userMessage = screenshotDataUrl
    ? { role: 'user', content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'low' } }
      ] }
    : { role: 'user', content: userText };

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': chrome.runtime.getURL('viewer.html'),
      'X-Title': 'Proaibro'
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        userMessage
      ],
      temperature: agentMode ? 0.25 : 0.7,
      max_tokens: 2200
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
  }
  const data = await response.json();
  return data.choices[0]?.message?.content || 'Нет ответа от модели';
}

async function loadPageFromStorage() {
  const data = await chrome.storage.session.get(STORAGE_KEYS);
  getEl('textContent').textContent = data.pageExtractedText || '';
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function renderMessages(messages) {
  const container = getEl('messagesContainer');
  container.innerHTML = '';
  if (!messages || messages.length === 0) return;
  messages.forEach(msg => {
    const block = document.createElement('div');
    block.className = 'message-block message-' + msg.role;
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = msg.role === 'user' ? 'Вы' : 'Помощник';
    const body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = escapeHtml(msg.content).replace(/\n/g, '<br>');
    block.appendChild(label);
    block.appendChild(body);
    container.appendChild(block);
  });
  container.scrollTop = container.scrollHeight;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function extractActionsFromResponse(text) {
  if (!text) return null;
  // Попытка достать JSON из markdown-блока ```json ... ```
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    const parsedFence = safeJsonParse(fenceMatch[1]);
    if (parsedFence?.actions) return parsedFence;
  }
  // Общий поиск первого JSON-объекта
  const braceMatch = text.match(/\{[\s\S]*\}/m);
  if (braceMatch) {
    const parsedBrace = safeJsonParse(braceMatch[0]);
    if (parsedBrace?.actions) return parsedBrace;
  }
  return null;
}

async function runAgentActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return 'Нет действий для выполнения.';
  try {
    console.log('Agent actions:', JSON.stringify(actions));
  } catch (_) {
    console.log('Agent actions (non-serializable)', actions);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return 'Не удалось получить активную вкладку для агента.';

  const results = [];
  for (const action of actions.slice(0, 10)) {
    const { type, selector, value, button, ms } = action || {};
    const safeValue = value == null ? '' : String(value);
    const safeButton = button || 'left';
    if (!type) {
      results.push('Пропущено действие без type');
      continue;
    }
    if ((type === 'click' || type === 'input' || type === 'move') && !selector) {
      results.push(`Пропущено ${type} без selector`);
      continue;
    }

    if (type === 'wait') {
      const dur = Math.min(Math.max(Number(ms) || 0, 0), 4000);
      await sleep(dur);
      results.push(`Ожидание ${dur} мс`);
      continue;
    }

    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [type, selector, safeValue, safeButton],
        func: (aType, aSelector, aValue, aButton) => {
          const el = aSelector ? document.querySelector(aSelector) : null;
          if (aType === 'move') {
            if (!el) return `Элемент не найден для move: ${aSelector}`;
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
            return `Навели курсор (scrollIntoView) на ${aSelector}`;
          }
          if (!el) return `Элемент не найден: ${aSelector}`;
          if (aType === 'click') {
            el.focus?.();
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: aButton === 'right' ? 2 : aButton === 'middle' ? 1 : 0 }));
            return `Клик (${aButton}) по ${aSelector}`;
          }
          if (aType === 'input') {
            if ('value' in el) {
              el.focus?.();
              el.value = aValue ?? '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return `Ввод в ${aSelector}: ${aValue}`;
            }
            return `Элемент не поддерживает value: ${aSelector}`;
          }
          return `Неизвестный тип действия: ${aType}`;
        }
      });
      results.push(res?.result || 'Действие выполнено');
    } catch (err) {
      results.push(`Ошибка при ${type}:${selector || ''} — ${err.message}`);
    }
  }
  return results.join('\n');
}

async function loadChat(chatId) {
  const chats = await getChats();
  const chat = chats[chatId];
  if (!chat) return;
  currentChatId = chatId;
  isPrivateMode = false;
  await chrome.storage.session.set({ [PRIVATE_MODE_KEY]: false });
  renderMessages(chat.messages);
  updateModeIndicator();
  renderHistoryList();
  try {
    window.location.hash = chatId;
  } catch (_) {}
}

async function newChat() {
  currentChatId = createChatId();
  isPrivateMode = false;
  await chrome.storage.session.set({ [PRIVATE_MODE_KEY]: false });
  await chrome.storage.session.remove([PRIVATE_CHAT_KEY]);
  renderMessages([]);
  updateModeIndicator();
  renderHistoryList();
  getEl('queryInput').value = '';
  try { window.location.hash = ''; } catch (_) {}
}

async function privateChat() {
  currentChatId = null;
  isPrivateMode = true;
  await chrome.storage.session.set({ [PRIVATE_MODE_KEY]: true, [PRIVATE_CHAT_KEY]: [] });
  renderMessages([]);
  updateModeIndicator();
  renderHistoryList();
  getEl('queryInput').value = '';
  try { window.location.hash = ''; } catch (_) {}
}

function updateModeIndicator() {
  const el = getEl('chatModeIndicator');
  if (isPrivateMode) {
    el.textContent = 'Приватный чат (не сохраняется)';
    el.className = 'chat-mode-indicator private';
  } else {
    el.textContent = 'Обычный чат (сохраняется)';
    el.className = 'chat-mode-indicator normal';
  }

  const agentEl = getEl('agentModeIndicator');
  if (agentEl) {
    if (isAgentMode) {
      agentEl.textContent = 'Режим агента включен: модель попробует выполнить действия на странице';
      agentEl.className = 'agent-mode-indicator on';
    } else {
      agentEl.textContent = 'Режим агента выключен: ответы только текстом';
      agentEl.className = 'agent-mode-indicator off';
    }
  }
}

async function deleteChat(chatId) {
  const chats = await getChats();
  delete chats[chatId];
  await chrome.storage.local.set({ [CHATS_KEY]: chats });
  const order = await getChatOrder();
  const newOrder = order.filter(id => id !== chatId);
  await chrome.storage.local.set({ [CHAT_ORDER_KEY]: newOrder });
  if (currentChatId === chatId) {
    await newChat();
  } else {
    renderHistoryList();
  }
}

async function deleteAllChats() {
  if (!confirm('Вы уверены, что хотите удалить все чаты? Это действие нельзя отменить.')) {
    return;
  }
  await chrome.storage.local.set({ [CHATS_KEY]: {}, [CHAT_ORDER_KEY]: [] });
  await newChat();
}

async function renderHistoryList() {
  const list = getEl('historyList');
  list.innerHTML = '';
  if (isPrivateMode) {
    getEl('deleteAllChatsBtn').style.display = 'none';
    return;
  }
  const order = await getChatOrder();
  const chats = await getChats();
  if (order.length === 0) {
    getEl('deleteAllChatsBtn').style.display = 'none';
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'history-empty';
    emptyMsg.textContent = 'История пуста';
    list.appendChild(emptyMsg);
    return;
  }
  getEl('deleteAllChatsBtn').style.display = 'block';
  order.slice(0, 50).forEach(chatId => {
    const chat = chats[chatId];
    if (!chat) return;
    const item = document.createElement('div');
    item.className = 'history-item';
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'history-link' + (chatId === currentChatId ? ' current' : '');
    const title = chat.title || new Date(chat.createdAt).toLocaleString('ru');
    const date = new Date(chat.createdAt).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    link.textContent = date + ' — ' + (title.length > 40 ? title.slice(0, 40) + '…' : title);
    link.title = title;
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      loadChat(chatId);
    });
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'history-delete-btn';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Удалить чат';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteChat(chatId);
    });
    item.appendChild(link);
    item.appendChild(deleteBtn);
    list.appendChild(item);
  });
}

async function initFromStorage() {
  const hash = (window.location.hash || '').replace(/^#/, '');
  if (hash && hash.startsWith('chat-')) {
    const chats = await getChats();
    if (chats[hash]) {
      currentChatId = hash;
      isPrivateMode = false;
      await chrome.storage.session.set({ [PRIVATE_MODE_KEY]: false });
      renderMessages(chats[hash].messages);
      updateModeIndicator();
      renderHistoryList();
      return;
    }
  }
  const session = await chrome.storage.session.get([PRIVATE_MODE_KEY, PRIVATE_CHAT_KEY]);
  await loadAgentModeFlag();
  if (session[PRIVATE_MODE_KEY] && Array.isArray(session[PRIVATE_CHAT_KEY])) {
    isPrivateMode = true;
    currentChatId = null;
    renderMessages(session[PRIVATE_CHAT_KEY]);
  } else {
    isPrivateMode = false;
    currentChatId = createChatId();
    renderMessages([]);
  }
  updateModeIndicator();
  renderHistoryList();

  const agentBtn = getEl('agentModeBtn');
  if (agentBtn) {
    agentBtn.textContent = 'Агент: ' + (isAgentMode ? 'вкл' : 'выкл');
  }
}

getEl('newChatBtn').addEventListener('click', newChat);
getEl('privateChatBtn').addEventListener('click', privateChat);
getEl('deleteAllChatsBtn').addEventListener('click', deleteAllChats);
getEl('agentModeBtn').addEventListener('click', async () => {
  isAgentMode = !isAgentMode;
  await chrome.storage.session.set({ [AGENT_MODE_KEY]: isAgentMode });
  getEl('agentModeBtn').textContent = 'Агент: ' + (isAgentMode ? 'вкл' : 'выкл');
  updateModeIndicator();
});

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
      func: () => ({
        title: document.title || 'Без названия',
        text: document.body ? document.body.innerText : ''
      })
    });

    const extracted = results?.[0]?.result || { title: tab.title || 'Без названия', text: '' };
    const { title, text } = extracted;

    await chrome.storage.session.set({
      pageExtractedTitle: title,
      pageExtractedText: text,
      pageExtractedUrl: tab.url || ''
    });
    await loadPageFromStorage();

    getEl('summaryLoading').style.display = 'block';
    const screenshotDataUrl = await getCompressedScreenshotDataUrl();
    let responseText;
    try {
      const trimmedScreenshot = screenshotDataUrl && screenshotDataUrl.length > SCREENSHOT_MAX_CHARS
        ? screenshotDataUrl.slice(0, SCREENSHOT_MAX_CHARS)
        : screenshotDataUrl;
      responseText = await sendQueryToModel(text, userQuery, isAgentMode, trimmedScreenshot);
    } catch (err) {
      console.error('Query failed:', err);
      responseText = 'Ошибка: ' + err.message;
    }
    getEl('summaryLoading').style.display = 'none';

    const titleSnippet = userQuery.slice(0, 50);

    if (isPrivateMode) {
      await appendPrivateMessage('user', userQuery);
      await appendPrivateMessage('assistant', responseText);
      const messages = await getPrivateMessages();
      renderMessages(messages);
    } else {
      if (!currentChatId) currentChatId = createChatId();
      await appendMessageToLocalChat(currentChatId, 'user', userQuery, titleSnippet);
      await appendMessageToLocalChat(currentChatId, 'assistant', responseText);
      const chats = await getChats();
      renderMessages((chats[currentChatId] || {}).messages || []);
      renderHistoryList();
    }

    if (isAgentMode) {
      const parsed = extractActionsFromResponse(responseText);
      if (parsed?.actions) {
        const execResult = await runAgentActions(parsed.actions);
        const followup = `Результат выполнения действий:\n${execResult}`;
        if (isPrivateMode) {
          await appendPrivateMessage('assistant', followup);
          const messages = await getPrivateMessages();
          renderMessages(messages);
        } else {
          await appendMessageToLocalChat(currentChatId, 'assistant', followup);
          const chats = await getChats();
          renderMessages((chats[currentChatId] || {}).messages || []);
          renderHistoryList();
        }
      } else {
        const notice = 'Агент: действий не найдено или JSON нераспознан.';
        if (isPrivateMode) {
          await appendPrivateMessage('assistant', notice);
          const messages = await getPrivateMessages();
          renderMessages(messages);
        } else {
          await appendMessageToLocalChat(currentChatId, 'assistant', notice);
          const chats = await getChats();
          renderMessages((chats[currentChatId] || {}).messages || []);
          renderHistoryList();
        }
      }
    }

    queryInput.value = '';
  } catch (err) {
    getEl('summaryLoading').style.display = 'none';
  }
  btn.textContent = 'Отправить запрос';
  btn.disabled = false;
});

loadApiKey();
loadPageFromStorage();
initFromStorage();
