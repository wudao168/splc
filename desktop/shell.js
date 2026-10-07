const status = document.querySelector('#status');
let working = false;
async function command(action, value) {
  if (working) return;
  working = true;
  document.querySelector('#extract').disabled = true;
  try { await window.desktopShell.command(action, value); }
  catch (error) { status.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /,''); status.className = 'error'; }
  finally { working = false; document.querySelector('#extract').disabled = false; }
}
for (const action of ['business','taobao','back','reload','home','extract']) document.querySelector('#' + action).addEventListener('click', () => command(action));
document.querySelector('#address').addEventListener('keydown', e => { if(e.key === 'Enter') command('navigate', e.target.value); });
window.desktopShell.onState(state => {
  status.textContent = state.message;
  status.className = state.error ? 'error' : '';
  document.querySelector('#business').classList.toggle('active', state.active === 'business');
  document.querySelector('#taobao').classList.toggle('active', state.active === 'taobao');
  if (document.activeElement !== document.querySelector('#address')) document.querySelector('#address').value = state.url || '';
});
