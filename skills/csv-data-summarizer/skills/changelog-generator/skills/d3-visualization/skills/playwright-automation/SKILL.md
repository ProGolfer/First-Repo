name: playwright-automation
description: Model-invoked Playwright automation for testing and validating web applications.
---

# Playwright Browser Automation

Automates browser testing and validation using Playwright.

## When to Use

- When testing web applications
- When validating UI behavior
- When capturing screenshots for documentation
- When automating browser interactions
- When debugging frontend issues

## Instructions

1. Understand the testing requirements
2. Set up Playwright browser context
3. Navigate to target URL
4. Perform required actions (click, type, scroll)
5. Capture screenshots or assertions as needed
6. Validate expected behavior
7. Report results with evidence (screenshots, logs)

## Common Patterns

```javascript
// Basic test structure
const { test, expect } = require('@playwright/test');

test('description', async ({ page }) => {
  await page.goto('https://example.com');
  await page.click('button');
  await expect(page.locator('text=Success')).toBeVisible();
});
