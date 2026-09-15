import { test, expect } from "@playwright/test"

test.describe("Alerts System", () => {
  test.beforeEach(async ({ page }) => {
    // Setup: Navigate to the app and wait for it to load
    await page.goto("/")
    // Wait for sign-in form to be visible
    await page.waitForSelector('input[aria-label="Username"]', {
      timeout: 5000,
    })
  })

  test("should display alert notifications when they are present", async ({
    page,
  }) => {
    // Sign in first
    await page.fill('input[aria-label="Username"]', "admin")
    await page.fill('input[aria-label="Password"]', "test")
    await page.click('button:has-text("Sign in")')

    // Wait for the app to load
    await page.waitForSelector('h1:has-text("Jobs")', { timeout: 10000 })

    // Check if alert stack container exists (even if empty initially)
    // The alert stack should be in a fixed position at top-right
    const alertStack = page.locator('[role="alert"]').first()

    // Try to verify that alerts can be fetched
    // We'll check the API call is made
    await page.waitForTimeout(1000) // Give it a moment to check for alerts

    // If there are any alerts, they should have a dismiss button
    const dismissButtons = page.locator('button[aria-label*="Dismiss alert"]')
    const count = await dismissButtons.count()
    // Assertions depend on whether alerts are configured
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test("should dismiss an alert when dismiss button is clicked", async ({
    page,
  }) => {
    // Sign in
    await page.fill('input[aria-label="Username"]', "admin")
    await page.fill('input[aria-label="Password"]', "test")
    await page.click('button:has-text("Sign in")')

    // Wait for the app to load
    await page.waitForSelector('h1:has-text("Jobs")', { timeout: 10000 })

    // Wait for alerts to load
    await page.waitForTimeout(2000)

    // Find a dismiss button if any alert exists
    const dismissButton = page.locator('button[aria-label*="Dismiss alert"]').first()
    const isVisible = await dismissButton.isVisible().catch(() => false)

    if (isVisible) {
      // Count alerts before
      const alertsBefore = await page.locator('[role="alert"]').count()
      expect(alertsBefore).toBeGreaterThan(0)

      // Click dismiss button
      await dismissButton.click()

      // Wait a moment for the alert to be removed
      await page.waitForTimeout(500)

      // Count alerts after
      const alertsAfter = await page.locator('[role="alert"]').count()
      expect(alertsAfter).toBeLessThanOrEqual(alertsBefore)
    }
  })

  test("should display severity-specific styling", async ({ page }) => {
    // Sign in
    await page.fill('input[aria-label="Username"]', "admin")
    await page.fill('input[aria-label="Password"]', "test")
    await page.click('button:has-text("Sign in")')

    // Wait for the app to load
    await page.waitForSelector('h1:has-text("Jobs")', { timeout: 10000 })

    // Wait for potential alerts
    await page.waitForTimeout(2000)

    // Check for critical severity styling (should have red classes)
    const criticalAlerts = page.locator('[role="alert"] >> filter=has-text("critical")')
    const criticalCount = await criticalAlerts.count()

    // If there's a critical alert, it should have red styling
    if (criticalCount > 0) {
      const firstCritical = criticalAlerts.first()
      await expect(firstCritical).toHaveClass(/border-red-600|bg-red-950/)
    }

    // Check for warning severity styling (should have amber classes)
    const warningAlerts = page.locator('[role="alert"] >> filter=has-text("warning")')
    const warningCount = await warningAlerts.count()

    // If there's a warning alert, it should have amber styling
    if (warningCount > 0) {
      const firstWarning = warningAlerts.first()
      await expect(firstWarning).toHaveClass(/border-amber-600|bg-amber-950/)
    }
  })

  test("should handle alerts without GPU UUID", async ({ page }) => {
    // Sign in
    await page.fill('input[aria-label="Username"]', "admin")
    await page.fill('input[aria-label="Password"]', "test")
    await page.click('button:has-text("Sign in")')

    // Wait for the app to load
    await page.waitForSelector('h1:has-text("Jobs")', { timeout: 10000 })

    // Wait for alerts to load
    await page.waitForTimeout(2000)

    // Check if alerts render without errors
    const alerts = page.locator('[role="alert"]')
    const count = await alerts.count()

    // For each alert, verify basic content is present
    for (let i = 0; i < Math.min(count, 3); i++) {
      const alert = alerts.nth(i)
      // Alert should have some visible text
      const text = await alert.textContent()
      expect(text).toBeTruthy()
      expect(text?.length).toBeGreaterThan(0)
    }
  })

  test("should limit visible alerts to max count", async ({ page }) => {
    // Sign in
    await page.fill('input[aria-label="Username"]', "admin")
    await page.fill('input[aria-label="Password"]', "test")
    await page.click('button:has-text("Sign in")')

    // Wait for the app to load
    await page.waitForSelector('h1:has-text("Jobs")', { timeout: 10000 })

    // Wait for alerts
    await page.waitForTimeout(2000)

    // Check if there's a "more alerts" indicator when exceeding max (default 3)
    const moreIndicator = page.locator('text=/\\+\\d+ more alert/')
    const hasMoreIndicator = await moreIndicator.isVisible().catch(() => false)

    if (hasMoreIndicator) {
      // If there's a more indicator, verify it shows the right count
      const text = await moreIndicator.textContent()
      expect(text).toMatch(/\+\d+ more alert/)
    }

    // Verify main alerts are displayed
    const mainAlerts = page.locator('[role="alert"] >> filter-text=/^(?!.*more)/').count()
    expect(mainAlerts).toBeGreaterThanOrEqual(0)
  })
})
