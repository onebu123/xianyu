/**
 * 使用 Playwright 对前端所有页面进行截图验证
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const BASE_URL = 'http://localhost:5173';

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  let idx = 1;
  function name(n) { return path.join(SCREENSHOTS_DIR, `${String(idx++).padStart(2,'0')}_${n}.png`); }

  // 1. 登录页
  console.log(`${idx}. 登录页`);
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: name('login'), fullPage: true });

  // 2. 登录
  console.log(`${idx}. 登录中...`);
  try { await page.fill('#username', 'admin'); } catch {}
  try { await page.fill('#password', 'SaleCompass@20260312'); } catch {}
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: name('dashboard'), fullPage: false });

  // 3. 仪表盘滚动
  console.log(`${idx}. 仪表盘滚动`);
  const inner = await page.$('.app-content-inner');
  if (inner) await inner.evaluate(el => el.scrollTop = 800);
  await page.waitForTimeout(500);
  await page.screenshot({ path: name('dashboard_scroll'), fullPage: false });
  // 滚回顶部
  if (inner) await inner.evaluate(el => el.scrollTop = 0);

  // 遍历所有导航按钮
  const navLabels = await page.$$eval('.nav-item-button .nav-item-label', els => els.map(e => e.textContent.trim()));
  console.log('找到导航项:', navLabels);

  for (const label of navLabels) {
    // 跳过已截过的"统计"(仪表盘)
    if (label === '统计') continue;

    console.log(`${idx}. ${label}`);
    const btn = await page.$(`.nav-item-button:has(.nav-item-label:text-is("${label}"))`);
    if (btn) {
      await btn.click();
      await page.waitForTimeout(2500);
      // 截图
      await page.screenshot({ path: name(label), fullPage: false });
      // 如果页面有内容可以滚动，再截一张滚动后的
      const scrollable = await page.$('.app-content-inner');
      if (scrollable) {
        const { scrollHeight, clientHeight } = await scrollable.evaluate(el => ({
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        }));
        if (scrollHeight > clientHeight + 200) {
          await scrollable.evaluate(el => el.scrollTop = el.scrollHeight);
          await page.waitForTimeout(500);
          await page.screenshot({ path: name(`${label}_底部`), fullPage: false });
          await scrollable.evaluate(el => el.scrollTop = 0);
        }
      }
    } else {
      console.log(`  ⚠ 未找到按钮: ${label}`);
    }
  }

  await browser.close();
  console.log(`\n全部截图完成（共 ${idx - 1} 张），保存于: ${SCREENSHOTS_DIR}`);
}

main().catch(err => { console.error('脚本失败:', err.message); process.exit(1); });
