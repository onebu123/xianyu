---
name: webapp-testing
description: Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs.
---

# Web Application Testing

To test local web applications, write native Playwright scripts (Node.js or Python).

## Decision Tree: Choosing Your Approach

```
User task → Is it static HTML?
    ├─ Yes → Read HTML file directly to identify selectors
    │         ├─ Success → Write Playwright script using selectors
    │         └─ Fails/Incomplete → Treat as dynamic (below)
    │
    └─ No (dynamic webapp) → Is the server already running?
        ├─ No → Start the server first, then write Playwright script
        │
        └─ Yes → Reconnaissance-then-action:
            1. Navigate and wait for networkidle
            2. Take screenshot or inspect DOM
            3. Identify selectors from rendered state
            4. Execute actions with discovered selectors
```

## Example: Node.js Playwright Script

```javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await page.screenshot({ path: '/tmp/screenshot.png', fullPage: true });
  // ... your automation logic
  await browser.close();
})();
```

## Reconnaissance-Then-Action Pattern

1. **Inspect rendered DOM**:
   ```javascript
   await page.screenshot({ path: '/tmp/inspect.png', fullPage: true });
   const content = await page.content();
   const buttons = await page.$$('button');
   ```

2. **Identify selectors** from inspection results

3. **Execute actions** using discovered selectors

## Common Pitfall

❌ **Don't** inspect the DOM before waiting for `networkidle` on dynamic apps
✅ **Do** wait for `page.waitForLoadState('networkidle')` before inspection

## Best Practices

- Always close the browser when done
- Use descriptive selectors: `text=`, `role=`, CSS selectors, or IDs
- Add appropriate waits: `page.waitForSelector()` or `page.waitForTimeout()`
- Use `headless: true` for CI/automated runs
- Save screenshots to `/tmp/` for debugging
