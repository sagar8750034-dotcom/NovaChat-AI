(function(){
  const messagesDiv = document.getElementById('messages');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');

  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = 'message ' + (role === 'user' ? 'user' : 'assistant');
    el.textContent = (role === 'user' ? 'You: ' : 'Bot: ') + text;
    messagesDiv.appendChild(el);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    return el;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addMessage('user', text);
    input.value = '';
    await sendMessage(text);
  });

  async function sendMessage(text) {
    const messagesPayload = [{role: 'user', content: text}];

    // Try streaming endpoint first
    try {
      const resp = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({messages: messagesPayload})
      });

      if (!resp.ok) throw new Error('Stream endpoint returned ' + resp.status);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let assistantEl = addMessage('assistant', '');
      let buffer = '';

      while (!done) {
        const {value, done: d} = await reader.read();
        done = d;
        if (value) {
          const chunk = decoder.decode(value, {stream: true});
          // If upstream used SSE-style "data: ..." framing, strip that
          const cleaned = chunk.replace(/\bdata:\s*/g, '');
          buffer += cleaned;
          assistantEl.textContent = 'Bot: ' + buffer;
          messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
      }

      // Attempt to parse JSON if upstream returned JSON object
      try {
        const parsed = JSON.parse(buffer);
        // Try common shapes (adjust if using different API)
        let textOut = '';
        if (parsed.output) textOut = JSON.stringify(parsed.output);
        else if (parsed.choices && parsed.choices[0]) textOut = parsed.choices[0].text || JSON.stringify(parsed);
        else textOut = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        assistantEl.textContent = 'Bot: ' + textOut;
      } catch (e) {
        // not JSON — leave as-is
      }

      return;
    } catch (err) {
      console.warn('Streaming failed, falling back to non-stream:', err);
    }

    // Fallback: non-streaming endpoint
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({messages: messagesPayload})
      });
      if (!r.ok) {
        const txt = await r.text();
        addMessage('assistant', 'Error: ' + r.status + ' ' + txt);
        return;
      }
      const json = await r.json();
      // Display something sensible depending on upstream shape
      let botReply = '';
      if (json && json.output) botReply = JSON.stringify(json.output);
      else if (json && json.choices && json.choices[0]) botReply = json.choices[0].text || JSON.stringify(json);
      else botReply = JSON.stringify(json);
      addMessage('assistant', botReply);
    } catch (e) {
      addMessage('assistant', 'Network error: ' + e.message);
    }
  }

})();
