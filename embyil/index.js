const { chromium } = require('playwright');
const TempMailAPI = require('./tinyhost');
const { generateNumericString, generateUsername5, generateStrongPassword } = require('./utils');

async function run(statusCallback = () => { }) {
    const originalLog = console.log;
    console.log = (...args) => {
        originalLog(...args);
        // We could write to a file here, but app.js will handle redirection
    };
    const browser = await chromium.launch({ headless: true }); // Headless for bot usage
    const context = await browser.newContext();
    const page = await context.newPage();

    const tempMail = new TempMailAPI();

    const strongFill = async (selector, value, parent = page) => {
        const locator = parent.locator(selector);
        await locator.click();
        await locator.clear();
        // Reduced delay for faster typing
        await locator.pressSequentially(value, { delay: 10 });
        // Explicitly trigger events as a fallback
        await locator.evaluate((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        });
    };

    try {
        statusCallback('[5%] ⚙️ מכין את פרטי החשבון החדש...');
        // Start fetching domain in parallel with page navigation
        const domainPromise = tempMail.getRandomDomains(1);

        const username = generateUsername5();
        const firstName = 'John';
        const lastName = 'Doe';
        const password = generateStrongPassword();

        statusCallback('[10%] 📝 מתחיל בתהליך ההרשמה לאתר...');
        // Use 'commit' for faster initial load if possible, or stick to networkidle for reliability
        const gotoPromise = page.goto('https://client.embyiltv.io/sign-up', { waitUntil: 'domcontentloaded' });

        const domainData = await domainPromise;
        const domain = domainData.domains[0];
        const email = `${username}@${domain}`;

        statusCallback(`[15%] 📧 אימייל זמני נוצר:\n<code>${email}</code>`);
        await gotoPromise;

        await page.waitForSelector('input[name="firstName"]', { timeout: 30000 });
        await strongFill('input[name="firstName"]', firstName);
        await strongFill('input[name="lastName"]', lastName);
        await strongFill('input[name="email"]', email);
        await strongFill('input[name="password"]', password);
        await strongFill('input[name="confirmPassword"]', password);

        // Check for any mandatory checkboxes (e.g., Terms of Service)
        const checkboxes = await page.locator('input[type="checkbox"], [role="checkbox"]').all();
        for (const checkbox of checkboxes) {
            try {
                if (!(await checkbox.isChecked())) {
                    await checkbox.click({ force: true });
                }
            } catch (e) {
                // Ignore if not clickable
            }
        }

        // Try to click any labels containing "מסכים" or "תנאי" (common Hebrew for "Agree" or "Terms")
        const labelsToWait = page.locator('label:has-text("מסכים"), label:has-text("תנאי"), label:has-text("Agree"), label:has-text("Terms")');
        const labelCount = await labelsToWait.count();
        for (let i = 0; i < labelCount; i++) {
            try {
                await labelsToWait.nth(i).click({ force: true });
            } catch (e) { }
        }

        await page.waitForTimeout(2000); // Wait for form validation to update

        statusCallback('[30%] שולח טופס הרשמה...');
        const submitBtn = page.locator('button[type="submit"]');

        // Wait up to 10 seconds for the button to become enabled
        try {
            await submitBtn.waitFor({ state: 'attached', timeout: 5000 });
            for (let i = 0; i < 10; i++) {
                if (await submitBtn.isEnabled()) break;
                await page.waitForTimeout(500); // Shorter check interval
            }
        } catch (e) { }

        await submitBtn.click();

        try {
            await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
        } catch (e) {
            statusCallback('[35%] ממתין לטעינת דף לאחר הרשמה...');
        }

        statusCallback('[40%] 📤 טופס ההרשמה נשלח בהצלחה.');

        statusCallback('[50%] ⏳ ממתין לאימייל אימות (זה עשוי לקחת רגע)...');

        const emailDetail = await tempMail.pollForEmail(domain, username, {
            senderKeyword: 'noreply@embyiltv.io'
        }, 300000);

        statusCallback('[65%] ✅ אימייל האימות התקבל!');

        const linkRegex = /https?:\/\/[^\s"'<>]+/g;
        const links = emailDetail.html_body.match(linkRegex) || [];
        // Support common Hebrew and English verification terms
        const verifyLink = links.find(l =>
            l.includes('verify') ||
            l.includes('confirm') ||
            l.includes('sign-up') ||
            l.includes('email-confirmation') ||
            l.includes('activation') ||
            l.includes('אימות') ||
            l.includes('confirm-email')
        );

        if (!verifyLink) {
            console.log('Available links in email:', links);
            throw new Error('קישור אימות לא נמצא באימייל');
        }

        statusCallback('[75%] 🔗 מבצע אימות חשבון...');
        const verifyPage = await context.newPage();
        const cleanLink = verifyLink.replace(/&amp;/g, '&');
        await verifyPage.goto(cleanLink, { waitUntil: 'commit' });
        await verifyPage.waitForTimeout(2000); // Reduced wait
        await verifyPage.close();

        statusCallback('[85%] 🔓 מבצע התחברות ראשונית...');
        await page.goto('https://client.embyiltv.io/login');
        await strongFill('input[name="login"]', email);
        await strongFill('input[name="password"]', password);

        statusCallback('[87%] שולח טופס התחברות...');
        await page.click('button[type="submit"]');

        try {
            await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
        } catch (e) {
            statusCallback('[88%] ממתין לטעינת דף התחברות...');
        }

        statusCallback('[90%] 💎 יוצר מנוי ניסיון בנגן...');
        if (!page.url().includes('subscriptions')) {
            await page.goto('https://client.embyiltv.io/subscriptions?page=0&sorts=%5B%5D', { waitUntil: 'domcontentloaded' });
        }
        await page.waitForTimeout(2000); // Reduced wait

        const dialogSelector = '[role="alertdialog"]';
        const hasDialog = await page.isVisible(dialogSelector);

        let embyLogin, embyPassword;

        if (hasDialog) {
            statusCallback('[91%] זוהה דיאלוג תקופת ניסיון. ממלא פרטים...');
            const dialog = page.locator(dialogSelector);

            embyLogin = generateNumericString(6);
            embyPassword = generateNumericString(4);

            await strongFill('input[name="login"]', embyLogin, dialog);
            await strongFill('input[name="password"]', embyPassword, dialog);
            await strongFill('input[name="confirmPassword"]', embyPassword, dialog);

            // Check for any mandatory checkboxes within the dialog
            const dialogCheckboxes = await dialog.locator('input[type="checkbox"], [role="checkbox"]').all();
            for (const checkbox of dialogCheckboxes) {
                try {
                    if (!(await checkbox.isChecked())) {
                        await checkbox.click({ force: true });
                    }
                } catch (e) { }
            }

            // Try to click any labels containing "מסכים" or "תנאי" inside the dialog
            const dialogLabels = dialog.locator('label:has-text("מסכים"), label:has-text("תנאי"), label:has-text("Agree"), label:has-text("Terms")');
            const dLabelCount = await dialogLabels.count();
            for (let i = 0; i < dLabelCount; i++) {
                try {
                    await dialogLabels.nth(i).click({ force: true });
                } catch (e) { }
            }

            statusCallback('[92%] שולח טופס תקופת ניסיון...');
            const confirmBtn = dialog.locator('button:has-text("אשר"), button:has-text("Confirm"), button:has-text("OK")');
            await confirmBtn.waitFor({ state: 'visible' });

            // Wait up to 20 seconds for the button to become enabled
            try {
                for (let i = 0; i < 20; i++) {
                    if (await confirmBtn.isEnabled()) break;
                    await page.waitForTimeout(1000);
                }
            } catch (e) { }

            await confirmBtn.click({ force: true });
            statusCallback('[94%] מנוי ניסיון נוצר בהצלחה.');
        } else {
            statusCallback('[91%] דיאלוג ניסיון לא נמצא. מנסה יצירה ידנית...');
            const createLineBtn = page.locator('button:has-text("צור"), button:has-text("חדש"), button:has-text("New"), button:has-text("Create")').first();
            if (await createLineBtn.isVisible()) {
                await createLineBtn.click();
                await page.waitForTimeout(2000);
            }

            embyLogin = generateNumericString(6);
            embyPassword = generateNumericString(4);

            await page.waitForSelector('input[name="login"]', { timeout: 30000 });
            await strongFill('input[name="login"]', embyLogin);

            const p1 = page.locator('input[name="password"]').nth(0);
            const cp = page.locator('input[name="confirmPassword"]');

            if (await p1.isVisible()) await strongFill('input[name="password"]', embyPassword);
            if (await cp.isVisible()) await strongFill('input[name="confirmPassword"]', embyPassword);

            // Check for checkboxes in manual creation
            const manualCheckboxes = await page.locator('input[type="checkbox"], [role="checkbox"]').all();
            for (const checkbox of manualCheckboxes) {
                try {
                    if (!(await checkbox.isChecked())) {
                        await checkbox.click({ force: true });
                    }
                } catch (e) { }
            }

            statusCallback('[92%] שולח טופס יצירת מנוי...');
            const submitBtn = page.locator('button:has-text("צור"), button:has-text("שמור"), button[type="submit"]').first();

            // Wait for enabled
            try {
                await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
                for (let i = 0; i < 10; i++) {
                    if (await submitBtn.isEnabled()) break;
                    await page.waitForTimeout(1000);
                }
            } catch (e) { }

            if (await submitBtn.isVisible() && await submitBtn.isEnabled()) {
                await submitBtn.click({ force: true });
            } else {
                await page.keyboard.press('Enter');
            }
        }

        statusCallback('[95%] ✨ כמעט סיימנו... מגדיר את כל הפרטים.');
        // Reduced from 20s to 5s - usually enough for the backend to sync
        await page.waitForTimeout(5000);

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
