// Diagnóstico de selectores para un chat nuevo. Pégalo en la consola (F12 → Console) de la página, con una respuesta del asistente visible,
// y envía el resultado (se copia solo al portapapeles). No lee el contenido de los mensajes, solo etiquetas y atributos.
(() => {
  const attrs = (e) => Object.fromEntries([...e.attributes].filter((a) => !['style', 'd', 'href', 'src'].includes(a.name)).map((a) => [a.name, a.value.slice(0, 60)]));
  const info = (e) => ({ tag: e.tagName.toLowerCase(), ...attrs(e), clase: String(e.className).slice(0, 80) });
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const sal = {
    url: location.href,
    editores: [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible).map(info),
    botones: [...document.querySelectorAll('button, [role="button"]')].filter(visible).filter((b) => b.closest('form') || b.getAttribute('aria-label') || b.type === 'submit').slice(-14).map(info),
    atributos_data: [...new Set([...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.name)).filter((n) => /^data-(message|role|testid|author|turn|part)/.test(n)))],
    bloques_markdown: [...document.querySelectorAll('[class*="markdown" i], [data-message-part-type], [data-message-author-role], [data-role]')].slice(-4).map(info),
    entradas_archivo: [...document.querySelectorAll('input[type=file]')].map(info),
  };
  const txt = JSON.stringify(sal, null, 1);
  console.log(txt);
  navigator.clipboard?.writeText(txt).then(() => console.log('✔ copiado al portapapeles'), () => {});
})();
