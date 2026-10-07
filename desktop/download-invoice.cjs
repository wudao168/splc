const fs = require('node:fs/promises');
const path = require('node:path');
const { clickInvoiceDownload } = require('./extract-invoice-detail.cjs');

// Download links may point to a separate invoice file host. They never navigate
// a privileged view, and the saved content must still be a PDF or OFD.
function isInvoiceDownloadURL(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'blob:') return url.origin === 'https://invoice-ua.taobao.com';
    const host = url.hostname;
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      host.includes('.') && !host.endsWith('.') && host !== 'localhost' && !host.endsWith('.localhost') &&
      !host.endsWith('.local') && !host.includes(':') && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
  } catch { return false; }
}

async function downloadInvoiceFile(source, order, number, tempRoot, setDownloadHandler) {
  const directory = await fs.mkdtemp(path.join(tempRoot, 'caidan-invoice-'));
  const remoteSession = source.session;
  let timer, activeDownload, completed = false, requested = false;
  let resolveTransfer, rejectTransfer;
  const transfer = new Promise((resolve, reject) => { resolveTransfer = resolve; rejectTransfer = reject; });
  // A download can fail while the page click is still being evaluated.
  transfer.catch(() => {});
  const onDownload = (event, item, contents) => {
    if (contents !== source) return;
    if (activeDownload) { item.cancel(); return; }
    let name = path.basename(item.getFilename());
    if (!/\.(pdf|ofd)$/i.test(name)) {
      const extension = {'application/pdf':'pdf', 'application/ofd':'ofd', 'application/vnd.ofd':'ofd'}[item.getMimeType()];
      if (!extension) { item.cancel(); rejectTransfer(new Error('下载响应不是 PDF 或 OFD，请在淘宝确认发票文件可下载。')); return; }
      name = `invoice-${number}.${extension}`;
    }
    activeDownload = item;
    const destination = path.join(directory, name);
    item.setSavePath(destination);
    item.once('done', (_, state) => {
      completed = state === 'completed';
      completed ? resolveTransfer({name, destination}) : rejectTransfer(new Error('发票下载中断，请重试。'));
    });
  };
  remoteSession.on('will-download', onDownload);
  setDownloadHandler(url => {
    if (!isInvoiceDownloadURL(url)) { rejectTransfer(new Error('发票下载链接无效，请在淘宝发票详情检查下载入口。')); return; }
    if (requested || activeDownload) return;
    requested = true;
    try { source.downloadURL(url); }
    catch { rejectTransfer(new Error('无法开始下载发票，请重试。')); }
  });
  timer = setTimeout(() => rejectTransfer(new Error('发票下载超时，请在淘宝确认登录状态及下载入口后重试。')), 30000);
  try {
    const clicked = await source.executeJavaScriptInIsolatedWorld(1001,
      [{code:`(${clickInvoiceDownload.toString()})(${JSON.stringify(order)},${JSON.stringify(number)})`}], true);
    if (!clicked) throw new Error('未找到此发票的下载按钮，请在淘宝查看发票详情。');
    const {name, destination} = await transfer;
    const content = await fs.readFile(destination);
    if (!content.length || content.length > 20 * 1024 * 1024) throw new Error('发票文件大小无效（上限 20 MB）。');
    if (name.toLowerCase().endsWith('.pdf') && !content.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('下载内容不是 PDF，可能需要重新登录淘宝。');
    if (name.toLowerCase().endsWith('.ofd') && !content.subarray(0, 2).equals(Buffer.from('PK'))) throw new Error('下载内容不是 OFD，请在淘宝核对发票文件。');
    return {name, content};
  } finally {
    clearTimeout(timer);
    setDownloadHandler(null);
    remoteSession.off('will-download', onDownload);
    if (activeDownload && !completed) activeDownload.cancel();
    await fs.rm(directory, {recursive:true, force:true});
  }
}

module.exports = { downloadInvoiceFile, isInvoiceDownloadURL };
