const { chromium } = require('playwright');
const TempMailAPI = require('./tinyhost');
const { generateNumericString, generateUsername5, generateStrongPassword } = require('../utils');

async function run(statusCallback = () => { }) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
        // Disable images/fonts to speed up page loads
        extraHTTPHeaders: { 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' }
    });

    // Block images, fonts, and media to reduce load time
    await context.route('**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf,otf,mp4,webm}', route => route.abort());

    const page = await context.newPage();
    const tempMail = new TempMailAPI();

    // Fill a field: click to focus, fill, then blur to trigger validation
    const fastFill = async (selector, value, parent = page) => {
        const locator = parent.locator(selector);
        await locator.waitFor({ state: 'visible', timeout: 15000 });
        await locator.click();
        await locator.fill(value);
        // Small pause so React processes the input event before we move on
        await page.waitForTimeout(150);
        await locator.evaluate(el => {
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
    };

    // Wait for a button to become enabled, with a timeout
    const waitForEnabled = async (locator, maxMs = 15000) => {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            if (await locator.isEnabled().catch(() => false)) return true;
            await page.waitForTimeout(300);
        }
        return false;
    };

    // Check and click all unchecked checkboxes within a parent
    const checkAllBoxes = async (parent = page) => {
        const boxes = await parent.locator('input[type="checkbox"], [role="checkbox"]').all();
        for (const box of boxes) {
            try {
                if (!(await box.isChecked())) await box.click({ force: true });
            } catch (e) { /* ignore unclickable */ }
        }
        // Also click any visible agree/terms labels
        const labels = parent.locator(
            'label:has-text("מסכים"), label:has-text("תנאי"), label:has-text("Agree"), label:has-text("Terms")'
        );
        const count = await labels.count();
        for (let i = 0; i < count; i++) {
            try { await labels.nth(i).click({ force: true }); } catch (e) { }
        }
    };

    try {
        statusCallback('[5%] ⚙️ מכין את פרטי החשבון החדש...');

        // Fetch domain and navigate to sign-up in parallel
        const domainPromise = tempMail.getRandomDomains(1);
        const username = generateUsername5();
        const password = generateStrongPassword();
        const gotoPromise = page.goto('https://client.embyiltv.io/sign-up', { waitUntil: 'domcontentloaded', timeout: 30000 });

        const domainData = await domainPromise;
        const domain = domainData.domains[0];
        const email = `${username}@${domain}`;

        statusCallback(`[12%] 📧 אימייל זמני: <code>${email}</code>`);
        await gotoPromise;

        // Wait for the form to be ready
        await page.waitForSelector('input[name="firstName"]', { timeout: 30000 });

        statusCallback('[20%] 📝 ממלא טופס הרשמה...');

        // Fill sequentially — parallel filling confuses React's focus/state tracking
        await fastFill('input[name="firstName"]', 'John');
        await fastFill('input[name="lastName"]', 'Doe');
        await fastFill('input[name="email"]', email);
        await fastFill('input[name="password"]', password);
        await fastFill('input[name="confirmPassword"]', password);

        // Check terms/checkboxes
        await checkAllBoxes(page);

        statusCallback('[30%] 🖱️ שולח טופס הרשמה...');

        // Wait for submit button to be enabled (form validation passed)
        const submitBtn = page.locator('button[type="submit"]');
        await submitBtn.waitFor({ state: 'attached', timeout: 10000 });
        const enabled = await waitForEnabled(submitBtn, 10000);

        if (!enabled) {
            // Try re-filling if validation didn't pass (sometimes fields need a nudge)
            await fastFill('input[name="email"]', email);
            await fastFill('input[name="password"]', password);
            await fastFill('input[name="confirmPassword"]', password);
            await checkAllBoxes(page);
            await waitForEnabled(submitBtn, 5000);
        }

        await submitBtn.click({ force: true });

        // Wait for the signup form to disappear OR a success/verify message to appear.
        // Don't rely on URL since success page may still contain 'sign-up' in its path.
        try {
            await page.waitForFunction(() => {
                const hasSignupForm = !!document.querySelector('input[name="firstName"]');
                const text = (document.body && document.body.innerText) || '';
                const hasSuccess = text.includes('נוצר') || text.includes('אישור') ||
                    text.includes('verify') || text.includes('success') ||
                    text.includes('confirmation') || text.includes('sent');
                return !hasSignupForm || hasSuccess;
            }, { timeout: 30000 });
        } catch (e) {
            await page.screenshot({ path: 'debug_signup.png', fullPage: true }).catch(() => {});
            throw new Error('טופס ההרשמה לא הוגש — ייתכן שהמייל כבר קיים');
        }

        statusCallback('[42%] ✅ טופס ההרשמה הוגש.');
        statusCallback('[50%] ⏳ ממתין לאימייל אימות...');

        // Poll for verification email — 2s interval for faster detection
        const emailDetail = await tempMail.pollForEmail(
            domain, username,
            { senderKeyword: 'noreply@embyiltv.io' },
            300000,
            2000 // 2s interval instead of 3s
        );

        statusCallback('[65%] ✅ אימייל האימות התקבל!');

        // Extract verification link
        const linkRegex = /https?:\/\/[^\s"'<>]+/g;
        const links = (emailDetail.html_body || '').match(linkRegex) || [];
        const verifyLink = links.find(l =>
            l.includes('verify') ||
            l.includes('confirm') ||
            l.includes('sign-up') ||
            l.includes('email-confirmation') ||
            l.includes('activation') ||
            l.includes('confirm-email') ||
            l.includes('token')
        );

        if (!verifyLink) {
            console.error('Links in email:', links);
            throw new Error('קישור אימות לא נמצא באימייל');
        }

        statusCallback('[75%] 🔗 מבצע אימות חשבון...');

        // Open verification link and wait for it to actually process
        const verifyPage = await context.newPage();
        await verifyPage.goto(verifyLink.replace(/&amp;/g, '&'), {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        // Wait for the verification to fully process before closing
        await verifyPage.waitForTimeout(3500);
        await verifyPage.close();

        statusCallback('[82%] 🔓 מתחבר לחשבון...');

        // Log in
        await page.goto('https://client.embyiltv.io/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('input[name="login"]', { timeout: 15000 });

        await fastFill('input[name="login"]', email);
        await fastFill('input[name="password"]', password);

        statusCallback('[86%] 🚀 שולח טופס התחברות...');
        await page.click('button[type="submit"]', { force: true });

        // Wait to navigate away from the /login page
        try {
            await page.waitForFunction(
                () => !window.location.href.includes('/login'),
                { timeout: 30000 }
            );
        } catch (e) {
            await page.screenshot({ path: 'debug_login.png', fullPage: true }).catch(() => {});
            throw new Error('ההתחברות נכשלה — ייתכן שהחשבון לא אומת');
        }

        statusCallback('[90%] 💎 פותח דף מנוי...');

        // Navigate to subscriptions
        await page.goto(
            'https://client.embyiltv.io/subscriptions?page=0&sorts=%5B%5D',
            { waitUntil: 'domcontentloaded', timeout: 30000 }
        );

        // Wait for either the trial dialog or the page content — up to 8s
        const dialogSelector = '[role="alertdialog"]';
        let hasDialog = false;
        try {
            await page.waitForSelector(dialogSelector, { timeout: 8000 });
            hasDialog = true;
        } catch (e) {
            hasDialog = await page.isVisible(dialogSelector);
        }

        const embyLogin = generateNumericString(6);
        const embyPassword = '1111';

        if (hasDialog) {
            statusCallback('[92%] 📋 ממלא פרטי נגן Emby...');
            const dialog = page.locator(dialogSelector);

            await fastFill('input[name="login"]', embyLogin, dialog);
            await fastFill('input[name="password"]', embyPassword, dialog);
            await fastFill('input[name="confirmPassword"]', embyPassword, dialog);

            await checkAllBoxes(dialog);

            const confirmBtn = dialog.locator(
                'button:has-text("אשר"), button:has-text("Confirm"), button:has-text("OK"), button[type="submit"]'
            ).first();
            await confirmBtn.waitFor({ state: 'visible', timeout: 10000 });
            await waitForEnabled(confirmBtn, 15000);

            statusCallback('[94%] ✅ שולח טופס ניסיון...');
            await confirmBtn.click({ force: true });

            // Wait for dialog to close (success)
            try {
                await page.waitForSelector(dialogSelector, { state: 'hidden', timeout: 15000 });
            } catch (e) { /* dialog may have already closed */ }

        } else {
            // Try clicking a "Create" button if dialog didn't auto-open
            statusCallback('[92%] 🔍 מחפש כפתור יצירת מנוי...');
            const createBtn = page.locator(
                'button:has-text("צור"), button:has-text("חדש"), button:has-text("New"), button:has-text("Create")'
            ).first();

            if (await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                await createBtn.click();

                // Now wait for the dialog to appear
                try {
                    await page.waitForSelector(dialogSelector, { timeout: 8000 });
                    const dialog = page.locator(dialogSelector);

                    await fastFill('input[name="login"]', embyLogin, dialog);
                    await fastFill('input[name="password"]', embyPassword, dialog);
                    await fastFill('input[name="confirmPassword"]', embyPassword, dialog);

                    await checkAllBoxes(dialog);

                    const confirmBtn = dialog.locator(
                        'button:has-text("אשר"), button:has-text("Confirm"), button:has-text("OK"), button[type="submit"]'
                    ).first();
                    await confirmBtn.waitFor({ state: 'visible', timeout: 10000 });
                    await waitForEnabled(confirmBtn, 15000);
                    await confirmBtn.click({ force: true });
                    try {
                        await page.waitForSelector(dialogSelector, { state: 'hidden', timeout: 10000 });
                    } catch (e) { }
                } catch (e) {
                    throw new Error('דיאלוג יצירת מנוי לא הופיע');
                }
            } else {
                throw new Error('לא נמצא דיאלוג או כפתור יצירת מנוי');
            }
        }

        // Verify the subscription was actually created by checking the page
        statusCallback('[97%] ✨ מאמת יצירת מנוי...');
        await page.waitForTimeout(2000);

        // Reload subscriptions page and check the new login appears
        await page.goto(
            'https://client.embyiltv.io/subscriptions?page=0&sorts=%5B%5D',
            { waitUntil: 'domcontentloaded', timeout: 30000 }
        );
        await page.waitForTimeout(2000);

        const pageText = await page.innerText('body').catch(() => '');
        if (!pageText.includes(embyLogin)) {
            // Last-ditch screenshot for debugging
            await page.screenshot({ path: 'debug_subscription.png', fullPage: true }).catch(() => {});
            throw new Error('המנוי לא נוצר — שם המשתמש לא נמצא בדף המנויים');
        }

        statusCallback('[100%] 🎊 הכל מוכן!');
        return {
            accountEmail: email,
            accountPassword: password,
            embyUsername: embyLogin,
            embyPassword: embyPassword
        };

    } catch (error) {
        statusCallback(`שגיאה: ${error.message}`);
        throw error;
    } finally {
        await browser.close();
    }
}

module.exports = { run };

if (require.main === module) {
    run(msg => console.log(msg)).catch(err => console.error('שגיאה סופית:', err));
}
