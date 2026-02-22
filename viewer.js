const STORAGE_KEYS = ['pageExtractedTitle', 'pageExtractedText', 'pageExtractedUrl'];
const CHATS_KEY = 'proaibro_chats';
const CHAT_ORDER_KEY = 'proaibro_chat_order';
const PRIVATE_CHAT_KEY = 'proaibro_private_messages';
const PRIVATE_MODE_KEY = 'proaibro_private_mode';
const AGENT_MODE_KEY = 'proaibro_agent_mode';
const SCREENSHOT_MAX_SIDE = 1024;
const SCREENSHOT_JPEG_QUALITY = 0.6;
const SCREENSHOT_MAX_CHARS = 120000; // защита от переполнения промпта
const MAX_ACTIONS = 10;
const INVENTORY_LIMIT = 120;
const INVENTORY_TEXT_MAX = 12000;
const INVENTORY_SUMMARY_LIMIT = 60;

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

async function sendQueryToModel(text, userQuery, agentMode, screenshotDataUrl, inventorySummary) {
  if (!apiKey) {
    await loadApiKey();
    if (!apiKey) throw new Error('API ключ не найден');
  }
  const pageText = (text || '').substring(0, 50000);
  const hasTextContent = pageText.trim().length > 0;
  const hasScreenshot = Boolean(screenshotDataUrl);
  const screenshotInfo = hasScreenshot ? 'Скриншот приложен (JPEG data URL).' : 'Скриншот недоступен или не смог быть снят.';
  const textInfo = hasTextContent ? 'Текст страницы получен.' : 'Текст страницы отсутствует или пуст.';

  const systemPrompt = `Ты помощник и агент. Тебе даётся запрос пользователя, текст открытой страницы и (если есть) скриншот страницы. Ты должен уметь визуально распознавать поля и кнопки на скриншоте и выполнять действия даже если селекторы неизвестны или отличаются от типовых. НЕ придумывай селекторы наугад — если не уверен, используй ocr_input/ocr_click и near.

Правила ответа:
1. Если ответ на запрос пользователя ЕСТЬ в тексте страницы или на скриншоте — опирайся на эти данные.
2. Если нужной информации нет или её недостаточно — ответь из своих знаний.
3. Если текста нет, опирайся только на скриншот. Если нет ни текста, ни скриншота — отвечай из общих знаний.

Если РЕЖИМ АГЕНТА ВЫКЛЮЧЕН: дай только текстовый ответ.

Если РЕЖИМ АГЕНТА ВКЛЮЧЕН: дай ДВА блока:
— Краткий план действий (2–5 шагов)
— JSON вида {"actions":[{"type":"input","selector":"CSS","value":"..."},{"type":"click","selector":"CSS"}]}
   * Поддерживаемые type: "input" (ввод текста), "click" (клик мышью), "move" (прокрутка и подвод курсора), "wait" (пауза в мс), "press" (клавиши), "focus" (фокус), "select" (выбор в <select>), "ocr_input" (ввод в поле, найденное по тексту на скриншоте), "ocr_click" (клик по элементу/кнопке, найденным по тексту на скриншоте), "finish" (завершение работы).
   * Для input/click/move/focus/select обязателен selector (CSS) ИЛИ точные координаты x и y (если можешь определить их по скриншоту). Можно указать несколько селекторов через "||" — пробуй слева направо. Для ocr_input/ocr_click селектор не обязателен, но можно добавить, если известен.
   * Для click можно указать button: "left" | "right" | "middle" (по умолчанию left).
   * Для wait укажи поле ms (0–4000).
   * Для press укажи keys (например: "Enter", "Tab", "ArrowDown", "Escape").
   * Для select укажи value ИЛИ label ИЛИ index.
   * Для ocr_input: укажи text (что ввести) и near (ключевые слова/ярлыки поля, например: "Откуда", "From"), чтобы модель подобрала поле по скриншоту/DOM-инвентарю.
   * Для ocr_click: укажи near (текст на кнопке/рядом), чтобы кликнуть по элементу, найденному по скриншоту/DOM-инвентарю.
   * Если ты видишь элемент на скриншоте, но не знаешь его селектор, ты можешь передать точные координаты x и y (в пикселях от левого верхнего угла страницы) для любого действия (click, input, move).
   * Если ты выполнил задачу пользователя и видишь результат на странице, ОБЯЗАТЕЛЬНО добавь действие {"type": "finish", "text": "Твой финальный ответ пользователю"}. Без этого действия ты будешь вызываться снова и снова!
   * Не больше ${MAX_ACTIONS} действий. Если выполнить нельзя — actions: [].
   * JSON должен быть валидным, без комментариев, и быть единственным JSON-блоком в формате \`\`\`json ... \`\`\`.

Отвечай на русском языке.`;

  const inventoryBlock = inventorySummary ? `\nDOM-инвентарь (ориентиры для near, не обязательно использовать селекторы):\n${inventorySummary}\n` : '';

  const userText = `Режим агента: ${agentMode ? 'ВКЛ' : 'ВЫКЛ'}
Запрос пользователя: ${userQuery.trim()}
${textInfo}
${screenshotInfo}
${inventoryBlock}

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
      model: 'anthropic/claude-opus-4.6',
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
  const inventory = await buildDomInventory(tab.id);

  for (const action of actions.slice(0, MAX_ACTIONS)) {
    const { type, selector, value, button, ms, keys, label, index, near, text, x, y } = action || {};
    const safeValue = value == null ? '' : String(value);
    const safeText = text == null ? safeValue : String(text);
    const safeNear = near == null ? '' : String(near);
    const safeButton = button || 'left';
    const safeKeys = keys || '';

    if (!type) {
      results.push('Пропущено действие без type');
      continue;
    }
    if ((type === 'click' || type === 'input' || type === 'move' || type === 'focus' || type === 'select') && !selector && !near && (x == null || y == null)) {
      results.push(`Пропущено ${type} без selector, near или координат`);
      continue;
    }

    if (type === 'finish') {
      results.push(`Агент завершил работу: ${text || safeValue || ''}`);
      continue;
    }

    if (type === 'wait') {
      const dur = Math.min(Math.max(Number(ms) || 0, 0), 4000);
      await sleep(dur);
      results.push(`Ожидание ${dur} мс`);
      continue;
    }

    try {
      const resultsArr = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        args: [
          type,
          selector || null,
          safeValue,
          safeButton,
          safeKeys,
          label || null,
          index === undefined ? null : index,
          safeNear,
          safeText,
          safeInventoryForArgs(inventory),
          x === undefined ? null : x,
          y === undefined ? null : y
        ],
        func: async (aType, aSelector, aValue, aButton, aKeys, aLabel, aIndex, aNear, aText, domInventory, aX, aY) => {
          let targetEl = null;
          if (aX != null && aY != null) {
            let el = document.elementFromPoint(aX, aY);
            while (el && el.shadowRoot) {
              const innerEl = el.shadowRoot.elementFromPoint(aX, aY);
              if (!innerEl || innerEl === el) break;
              el = innerEl;
            }
            targetEl = el;
          }

          const pickElement = (sel) => {
            if (!sel) return null;
            const parts = String(sel).split('||').map(s => s.trim()).filter(Boolean);
            for (const p of parts) {
              try {
                if (p.startsWith('//') || p.startsWith('(/')) {
                  const result = document.evaluate(p, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                  if (result.singleNodeValue) return result.singleNodeValue;
                } else {
                  const querySelectorDeep = (selector, root = document) => {
                    const el = root.querySelector(selector);
                    if (el) return el;
                    const elements = root.querySelectorAll('*');
                    for (const e of elements) {
                      if (e.shadowRoot) {
                        const found = querySelectorDeep(selector, e.shadowRoot);
                        if (found) return found;
                      }
                    }
                    return null;
                  };
                  const found = querySelectorDeep(p);
                  if (found) return found;
                }
              } catch (e) {
                // ignore invalid selector
              }
            }
            return null;
          };

          const findByInventory = (nearText, role) => {
            if (!nearText) return null;
            const needle = nearText.toLowerCase();
            
            // 1. Try domInventory
            const items = Array.isArray(domInventory) ? domInventory : [];
            const candidates = items.filter(it => (role ? it.role === role : true) && it.text.toLowerCase().includes(needle));
            const querySelectorDeep = (selector, root = document) => {
              const el = root.querySelector(selector);
              if (el) return el;
              const elements = root.querySelectorAll('*');
              for (const e of elements) {
                if (e.shadowRoot) {
                  const found = querySelectorDeep(selector, e.shadowRoot);
                  if (found) return found;
                }
              }
              return null;
            };

            if (candidates.length > 0) {
              for (const target of candidates) {
                try {
                  const el = querySelectorDeep(target.selector);
                  if (el) return el;
                } catch(e) {}
              }
            }
            
            const querySelectorAllDeep = (selector, root = document) => {
              const result = [];
              const elements = root.querySelectorAll('*');
              for (const el of elements) {
                if (el.matches && el.matches(selector)) result.push(el);
                if (el.shadowRoot) result.push(...querySelectorAllDeep(selector, el.shadowRoot));
              }
              return result;
            };

            // 2. Fallback: search DOM for text
            const allElements = querySelectorAllDeep(role === 'button' ? 'button, [role="button"], a' : 'input, textarea, select, [role="textbox"], [contenteditable="true"]');
            for (const el of allElements) {
              let text = '';
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                text = el.placeholder || el.ariaLabel || el.name || el.id || '';
                if (el.labels && el.labels.length > 0) {
                  text += ' ' + Array.from(el.labels).map(l => l.innerText || l.textContent).join(' ');
                } else if (el.id) {
                  const root = el.getRootNode();
                  const label = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                  if (label) text += ' ' + (label.innerText || label.textContent);
                }
                if (el.parentElement) {
                  text += ' ' + (el.parentElement.innerText || el.parentElement.textContent);
                }
              } else {
                text = el.innerText || el.textContent || el.ariaLabel || el.title || '';
              }
              if (text.toLowerCase().includes(needle)) {
                return el;
              }
            }
            
            // 3. If still not found, find any element containing the text
            const searchInShadowDOM = (root, needle) => {
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
              let node;
              while (node = walker.nextNode()) {
                if (node.nodeValue.toLowerCase().includes(needle)) return node;
              }
              const elements = root.querySelectorAll('*');
              for (const el of elements) {
                if (el.shadowRoot) {
                  const found = searchInShadowDOM(el.shadowRoot, needle);
                  if (found) return found;
                }
              }
              return null;
            };

            const node = searchInShadowDOM(document.body, needle);
            if (node) {
              let parent = node.parentElement;
                if (role === 'button') {
                  while (parent && parent !== document.body) {
                    if (parent.tagName === 'BUTTON' || parent.tagName === 'A' || parent.getAttribute('role') === 'button' || parent.onclick) {
                      return parent;
                    }
                    parent = parent.parentElement;
                  }
                } else if (role === 'input') {
                  let p = parent;
                  while (p && p !== document.body) {
                    const input = p.querySelector('input, textarea, select, [contenteditable="true"]');
                    if (input) return input;
                    p = p.parentElement;
                  }
                  p = parent;
                  while (p && p !== document.body) {
                    let sibling = p.nextElementSibling;
                    while (sibling) {
                      const input = sibling.matches('input, textarea, select, [contenteditable="true"]') ? sibling : sibling.querySelector('input, textarea, select, [contenteditable="true"]');
                      if (input) return input;
                      sibling = sibling.nextElementSibling;
                    }
                    p = p.parentElement;
                  }
                }
                return node.parentElement;
            }
            
            return null;
          };

          if (!targetEl) {
            const el = pickElement(aSelector);
            const ocrEl = findByInventory(aNear, aType === 'ocr_click' ? 'button' : 'input');
            targetEl = el || ocrEl;
          }

          const moveFakeCursor = async (el, x, y) => {
            let cursor = document.getElementById('proaibro-fake-cursor');
            if (!cursor) {
              cursor = document.createElement('div');
              cursor.id = 'proaibro-fake-cursor';
              cursor.style.position = 'fixed';
              cursor.style.width = '30px';
              cursor.style.height = '30px';
              cursor.style.borderRadius = '50%';
              cursor.style.backgroundColor = 'rgba(255, 0, 0, 0.8)';
              cursor.style.border = '2px solid white';
              cursor.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';
              cursor.style.pointerEvents = 'none';
              cursor.style.zIndex = '2147483647';
              cursor.style.transition = 'all 1s ease-in-out';
              
              // Start from center of screen if new
              cursor.style.left = `${window.innerWidth / 2}px`;
              cursor.style.top = `${window.innerHeight / 2}px`;
              document.body.appendChild(cursor);
              
              // Force reflow
              cursor.getBoundingClientRect();
            }
            if (el) {
              const rect = el.getBoundingClientRect();
              x = rect.left + rect.width / 2;
              y = rect.top + rect.height / 2;
            }
            if (x != null && y != null) {
              cursor.style.left = `${x - 15}px`;
              cursor.style.top = `${y - 15}px`;
            }
            
            // Wait for transition to finish
            await new Promise(r => setTimeout(r, 1000));
            return { x, y };
          };

          if (aType === 'move') {
            if (!targetEl && (aX == null || aY == null)) return `Элемент не найден для move: ${aSelector || aNear}`;
            if (targetEl) targetEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
            const coords = await moveFakeCursor(targetEl, aX, aY);
            return `Навели курсор на ${aSelector || aNear || `[${aX},${aY}]`} [${Math.round(coords.x)},${Math.round(coords.y)}]`;
          }

          if (aType === 'focus') {
            if (!targetEl) return `Элемент не найден для focus: ${aSelector || aNear}`;
            targetEl.focus?.();
            await moveFakeCursor(targetEl, aX, aY);
            return `Фокус на ${aSelector || aNear}`;
          }

          if (aType === 'press') {
            const key = aKeys || '';
            let active = document.activeElement;
            while (active && active.shadowRoot && active.shadowRoot.activeElement) {
              active = active.shadowRoot.activeElement;
            }
            const tgt = targetEl || active || document.body;
            if (!tgt) return 'Нет элемента для press';
            const eventInit = { key, code: key, bubbles: true, cancelable: true, composed: true, view: window };
            tgt.dispatchEvent(new KeyboardEvent('keydown', eventInit));
            tgt.dispatchEvent(new KeyboardEvent('keypress', eventInit));
            tgt.dispatchEvent(new KeyboardEvent('keyup', eventInit));
            return `Нажали клавишу ${key}`;
          }

          if (!targetEl) return `Элемент не найден: ${aSelector || aNear || `[${aX},${aY}]`}`;

          if (aType === 'click' || aType === 'ocr_click') {
            targetEl.focus?.();
            const coords = await moveFakeCursor(targetEl, aX, aY);
            
            let cursor = document.getElementById('proaibro-fake-cursor');
            if (cursor) {
              cursor.style.backgroundColor = 'rgba(0, 255, 0, 0.8)';
              cursor.style.transform = 'scale(0.8)';
              setTimeout(() => {
                cursor.style.backgroundColor = 'rgba(255, 0, 0, 0.8)';
                cursor.style.transform = 'scale(1)';
              }, 200);
            }

            const btn = aButton === 'right' ? 2 : aButton === 'middle' ? 1 : 0;
            const eventInit = { bubbles: true, cancelable: true, composed: true, view: window, clientX: coords.x, clientY: coords.y, button: btn, pointerId: 1, pointerType: 'mouse', isPrimary: true };
            targetEl.dispatchEvent(new PointerEvent('pointerdown', eventInit));
            targetEl.dispatchEvent(new MouseEvent('mousedown', eventInit));
            targetEl.dispatchEvent(new PointerEvent('pointerup', eventInit));
            targetEl.dispatchEvent(new MouseEvent('mouseup', eventInit));
            targetEl.dispatchEvent(new MouseEvent('click', eventInit));
            return `Клик (${aButton}) по ${aSelector || aNear || `[${aX},${aY}]`}`;
          }

          if (aType === 'input' || aType === 'ocr_input') {
            if (!('value' in targetEl) && !targetEl.isContentEditable) {
              let active = document.activeElement;
              while (active && active.shadowRoot && active.shadowRoot.activeElement) {
                active = active.shadowRoot.activeElement;
              }
              if (active && ('value' in active || active.isContentEditable)) {
                targetEl = active;
              }
            }
            
            if ('value' in targetEl || targetEl.isContentEditable) {
              targetEl.focus?.();
              await moveFakeCursor(targetEl, aX, aY);
              
              const textToType = aText || aValue || '';
              
              if (targetEl.isContentEditable) {
                targetEl.innerText = textToType;
              } else {
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
                const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
                
                if (targetEl instanceof HTMLInputElement && nativeInputValueSetter) {
                  nativeInputValueSetter.call(targetEl, textToType);
                } else if (targetEl instanceof HTMLTextAreaElement && nativeTextAreaValueSetter) {
                  nativeTextAreaValueSetter.call(targetEl, textToType);
                } else {
                  targetEl.value = textToType;
                }
              }
              
              targetEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              targetEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
              return `Ввод в ${aSelector || aNear || `[${aX},${aY}]`}: ${textToType}`;
            }
            return `Элемент (${targetEl.tagName}) не поддерживает value: ${aSelector || aNear || `[${aX},${aY}]`}`;
          }

          if (aType === 'select') {
            if (!(targetEl instanceof HTMLSelectElement)) return `Элемент не <select>: ${aSelector || aNear}`;
            const options = Array.from(targetEl.options || []);
            let applied = false;
            if (aValue != null) {
              const v = String(aValue);
              const found = options.find(o => o.value === v);
              if (found) { targetEl.value = v; applied = true; }
            }
            if (!applied && aLabel != null) {
              const lbl = String(aLabel).toLowerCase();
              const found = options.find(o => (o.label || o.textContent || '').toLowerCase() === lbl);
              if (found) { targetEl.value = found.value; applied = true; }
            }
            if (!applied && aIndex != null && !Number.isNaN(Number(aIndex))) {
              const idx = Math.max(0, Math.min(options.length - 1, Number(aIndex)));
              if (options[idx]) { targetEl.selectedIndex = idx; applied = true; }
            }
            if (applied) {
              targetEl.dispatchEvent(new Event('input', { bubbles: true }));
              targetEl.dispatchEvent(new Event('change', { bubbles: true }));
              return `Выбрано в ${aSelector || aNear}`;
            }
            return `Не удалось выбрать опцию в ${aSelector || aNear}`;
          }

          return `Неизвестный тип действия: ${aType}`;
        }
      });
      
      let successRes = null;
      let errorRes = null;
      for (const r of resultsArr) {
        if (r.result && !r.result.startsWith('Элемент не найден')) {
          successRes = r.result;
          break;
        } else if (r.result) {
          errorRes = r.result;
        }
      }
      results.push(successRes || errorRes || 'Действие выполнено');
    } catch (err) {
      results.push(`Ошибка при ${type}:${selector || ''} — ${err.message}`);
    }
  }
  return results.join('\n');
}

async function buildDomInventory(tabId) {
  try {
    const resultsArr = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [INVENTORY_LIMIT, INVENTORY_TEXT_MAX],
      func: (limit, textMax) => {
        const querySelectorAllDeep = (selector, root = document) => {
          const result = [];
          const elements = root.querySelectorAll('*');
          for (const el of elements) {
            if (el.matches && el.matches(selector)) result.push(el);
            if (el.shadowRoot) result.push(...querySelectorAllDeep(selector, el.shadowRoot));
          }
          return result;
        };

        const items = [];
        const nodes = querySelectorAllDeep('input, textarea, button, select, [role="button"], [role="textbox"], [contenteditable="true"]');
        for (const el of nodes.slice(0, limit)) {
          let text = '';
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            text = el.placeholder || '';
            if (!text) text = el.ariaLabel || '';
            if (!text && el.labels && el.labels.length > 0) {
              text = Array.from(el.labels).map(l => l.innerText || l.textContent).join(' ');
            } else if (!text && el.id) {
              try {
                const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (label) text = label.innerText || label.textContent;
              } catch(e) {}
            }
          } else {
            text = el.innerText || el.textContent || '';
          }
          text = (text || '').trim();
          if (text.length > textMax) text = text.slice(0, textMax);

          const role = el instanceof HTMLButtonElement || el.getAttribute('role') === 'button' ? 'button'
            : (el instanceof HTMLSelectElement ? 'select'
            : (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.getAttribute('role') === 'textbox' || el.isContentEditable ? 'input' : 'other'));

          items.push({
            selector: getUniqueSelector(el),
            text,
            tag: el.tagName.toLowerCase(),
            role
          });
        }
        return items;

        function getUniqueSelector(el) {
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const aria = el.getAttribute('aria-label');
          if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
          const classes = (el.className || '').split(/\s+/).filter(Boolean).slice(0, 3).map(c => `.${CSS.escape(c)}`).join('');
          const tag = el.tagName.toLowerCase();
          return classes ? `${tag}${classes}` : tag;
        }
      }
    });
    let allItems = [];
    if (resultsArr && Array.isArray(resultsArr)) {
      for (const r of resultsArr) {
        if (r.result && Array.isArray(r.result)) {
          allItems = allItems.concat(r.result);
        }
      }
    }
    return allItems;
  } catch (err) {
    console.warn('buildDomInventory failed', err);
  }
  return [];
}

function safeInventoryForArgs(inventory) {
  try {
    const sliced = Array.isArray(inventory) ? inventory.slice(0, INVENTORY_SUMMARY_LIMIT) : [];
    return JSON.parse(JSON.stringify(sliced));
  } catch (_) {
    return [];
  }
}

function buildInventorySummary(inventory) {
  const list = Array.isArray(inventory) ? inventory : [];
  return list.slice(0, INVENTORY_SUMMARY_LIMIT).map((item, idx) => {
    const text = (item.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return `${idx + 1}. [${item.role}] ${item.tag} ${item.selector} :: ${text || '—'}`;
  }).join('\n');
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

let isAgentRunning = false;

getEl('stopAgentBtn').addEventListener('click', () => {
  isAgentRunning = false;
  getEl('stopAgentBtn').style.display = 'none';
  getEl('sendBtn').disabled = false;
  getEl('sendBtn').textContent = 'Отправить запрос';
});

document.getElementById('sendBtn').addEventListener('click', async () => {
  if (isAgentRunning) return;
  
  const btn = getEl('sendBtn');
  const queryInput = getEl('queryInput');
  const userQuery = queryInput.value.trim();
  if (!userQuery) {
    queryInput.focus();
    return;
  }

  isAgentRunning = true;
  btn.disabled = true;
  btn.textContent = 'Обработка...';
  if (isAgentMode) {
    getEl('stopAgentBtn').style.display = 'inline-block';
  }

  try {
    let currentQuery = userQuery;
    let iteration = 0;
    const maxIterations = 10;

    while (isAgentRunning && iteration < maxIterations) {
      iteration++;
      
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        btn.textContent = 'Ошибка: нет вкладки';
        break;
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
      const inventory = await buildDomInventory(tab.id);
      const inventorySummary = buildInventorySummary(inventory);
      let responseText;
      try {
        const trimmedScreenshot = screenshotDataUrl && screenshotDataUrl.length > SCREENSHOT_MAX_CHARS
          ? screenshotDataUrl.slice(0, SCREENSHOT_MAX_CHARS)
          : screenshotDataUrl;
        responseText = await sendQueryToModel(text, currentQuery, isAgentMode, trimmedScreenshot, inventorySummary);
      } catch (err) {
        console.error('Query failed:', err);
        responseText = 'Ошибка: ' + err.message;
        isAgentRunning = false;
      }
      getEl('summaryLoading').style.display = 'none';

      const titleSnippet = userQuery.slice(0, 50);

      if (isPrivateMode) {
        if (iteration === 1) await appendPrivateMessage('user', userQuery);
        await appendPrivateMessage('assistant', responseText);
        const messages = await getPrivateMessages();
        renderMessages(messages);
      } else {
        if (!currentChatId) currentChatId = createChatId();
        if (iteration === 1) await appendMessageToLocalChat(currentChatId, 'user', userQuery, titleSnippet);
        await appendMessageToLocalChat(currentChatId, 'assistant', responseText);
        const chats = await getChats();
        renderMessages((chats[currentChatId] || {}).messages || []);
        renderHistoryList();
      }

      if (!isAgentMode) {
        break;
      }

      const parsed = extractActionsFromResponse(responseText);
      if (parsed?.actions) {
        const hasFinish = parsed.actions.some(a => a.type === 'finish');
        
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

        if (hasFinish) {
          isAgentRunning = false;
          break;
        }
        
        if (isAgentRunning) {
          await sleep(2000);
          currentQuery = `Оригинальный запрос пользователя: "${userQuery}"\n\nПродолжай выполнение задачи. Предыдущие действия выполнены. Если задача полностью завершена и ты видишь финальный результат на странице, используй действие finish. Если нет — продолжай выполнять нужные действия.`;
        }
      } else {
        const notice = 'Агент: действий не найдено или JSON нераспознан. Остановка.';
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
        isAgentRunning = false;
        break;
      }
    }
    
    if (iteration >= maxIterations) {
      const notice = 'Достигнут лимит итераций агента.';
      if (isPrivateMode) {
        await appendPrivateMessage('assistant', notice);
        renderMessages(await getPrivateMessages());
      } else {
        await appendMessageToLocalChat(currentChatId, 'assistant', notice);
        const chats = await getChats();
        renderMessages((chats[currentChatId] || {}).messages || []);
      }
    }

    queryInput.value = '';
  } catch (err) {
    getEl('summaryLoading').style.display = 'none';
  } finally {
    isAgentRunning = false;
    getEl('stopAgentBtn').style.display = 'none';
    btn.textContent = 'Отправить запрос';
    btn.disabled = false;
  }
});

loadApiKey();
loadPageFromStorage();
initFromStorage();
