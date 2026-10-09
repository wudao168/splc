const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-products-'));
  const python = process.env.CAIDAN_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
  const server = spawn(python, ['-u', '-m', 'server.app', '--port', '0'], {
    cwd: root, env: { ...process.env, CAIDAN_DATA: path.join(temp, 'data') }, windowsHide: true
  });
  let browser;
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('服务启动超时')), 30000);
      server.on('error', reject);
      server.on('exit', code => reject(new Error(`服务退出：${code}`)));
      server.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/Caidan running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1395, height: 892 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#products');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const panel = page.locator('.products-page > .panel');
    const card = page.locator('.products-page > .inventory-summary');
    await card.waitFor();
    const summaryTop = await card.evaluate(node => Math.round(node.getBoundingClientRect().top));
    const toolbarTop = await panel.locator('.toolbar').evaluate(node => Math.round(node.getBoundingClientRect().top));
    assert.ok(summaryTop < toolbarTop, `汇总应位于搜索栏上方（汇总 ${summaryTop} / 搜索 ${toolbarTop}）`);
    const labels = await card.locator('> div > small').allInnerTexts();
    assert.deepEqual(labels, ['料品数', '现存量', '可用库存', '公共在途', '库存金额', '型号对应']);
    const summaryHeight = await card.evaluate(node => Math.round(node.getBoundingClientRect().height));
    assert.equal(summaryHeight, 70, `产品库卡片行高应为 70px（实际 ${summaryHeight}）`);
    const metrics = await page.evaluate(() => {
      const card = document.querySelector('.products-page > .inventory-summary');
      const cell = card.querySelector(':scope > div');
      const label = cell.querySelector('small');
      const value = cell.querySelector('strong');
      const probe = document.createElement('span');
      probe.style.color = 'var(--teal)';
      document.body.appendChild(probe);
      const teal = getComputedStyle(probe).color;
      probe.remove();
      return {
        cardTop: card.getBoundingClientRect().top, cardBottom: card.getBoundingClientRect().bottom,
        labelTop: label.getBoundingClientRect().top, valueBottom: value.getBoundingClientRect().bottom,
        color: getComputedStyle(value).color, teal,
      };
    });
    assert.ok(Math.abs((metrics.labelTop - metrics.cardTop) - (metrics.cardBottom - metrics.valueBottom)) <= 1.5, `上下留白应一致（上 ${(metrics.labelTop - metrics.cardTop).toFixed(1)} / 下 ${(metrics.cardBottom - metrics.valueBottom).toFixed(1)}）`);
    assert.equal(metrics.color, metrics.teal, '数字应使用主题色');
    const panelGap = await page.evaluate(() => {
      const card = document.querySelector('.products-page > .inventory-summary');
      const panel = document.querySelector('.products-page > .panel');
      return panel.getBoundingClientRect().top - card.getBoundingClientRect().bottom;
    });
    assert.ok(Math.abs(panelGap - 5) < 1, `产品库卡片与下方容器应间隔 5px（实际 ${panelGap}）`);
    await page.screenshot({ path: path.join(temp, 'products.png') });
    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 产品库汇总已移到顶部；截图：', path.join(temp, 'products.png'));
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
