# Pre-Git Upload Security Checklist

Before pushing your code to GitHub, verify each item:

## ✅ Files Created

- [x] `.gitignore` - Excludes sensitive files
- [x] `.env` - Contains your secrets (NOT committed)
- [x] `.env.example` - Template for environment variables
- [x] `README.md` - Project documentation
- [x] `SECURITY.md` - Security guidelines
- [x] `db.json.example` - Database template
- [x] `CHECKLIST.md` - This file

## ✅ Code Updated

- [x] `app.js` - Now uses `process.env.TELEGRAM_BOT_TOKEN`
- [x] `app.js` - Now uses `process.env.ADMIN_CHAT_ID`
- [x] `bot.js` - Now uses `process.env.TELEGRAM_BOT_TOKEN`
- [x] `dotenv` package installed

## ✅ Secrets Removed

- [x] No hardcoded Telegram bot tokens
- [x] No hardcoded admin chat IDs
- [x] No hardcoded API keys
- [x] No hardcoded passwords

## ✅ Files Ignored

Verify these are in `.gitignore`:

- [x] `node_modules/`
- [x] `.env` and `.env.local`
- [x] `db.json` (contains user data)
- [x] `*.log` files
- [x] IDE config files

## 🔍 Final Verification Steps

Run these commands before committing:

```bash
# 1. Check .gitignore is working
git status

# 2. Verify no secrets in tracked files
git diff

# 3. Check for accidental token exposure
findstr /s "8554167822" *.js
# Should only find results in .env file, NOT in .js files

# 4. Verify .env is ignored
git check-ignore .env
# Should output: .env

# 5. Test the application still works
node app.js
```

## 📝 What to Commit

**Safe to commit:**
- ✅ `app.js` (updated with environment variables)
- ✅ `bot.js` (updated with environment variables)
- ✅ `database.js`
- ✅ `utils.js`
- ✅ `server.js`
- ✅ `tinyhost.js`
- ✅ `embyil/` folder (source code)
- ✅ `public/` folder (static files)
- ✅ `package.json`
- ✅ `package-lock.json`
- ✅ `start.bat`
- ✅ `.gitignore`
- ✅ `.env.example`
- ✅ `README.md`
- ✅ `SECURITY.md`
- ✅ `CHECKLIST.md`
- ✅ `db.json.example`

**NEVER commit:**
- ❌ `.env` (contains real secrets)
- ❌ `db.json` (contains user data)
- ❌ `node_modules/` (too large, auto-generated)
- ❌ `*.log` files
- ❌ Any file with tokens, passwords, or personal data

## 🚀 Git Commands to Upload

Once verified, use these commands:

```bash
# Initialize git repository (if not already done)
git init

# Add all safe files
git add .

# Check what will be committed
git status

# Create your first commit
git commit -m "Initial commit - secure version with environment variables"

# Add your remote repository
git remote add origin <your-github-repo-url>

# Push to GitHub
git push -u origin main
```

## ⚠️ Emergency: If You Accidentally Committed Secrets

1. **Revoke the exposed token immediately**
   - For Telegram: Contact @BotFather to revoke the token

2. **Remove from Git history**
   ```bash
   git filter-branch --force --index-filter \
     "git rm --cached --ignore-unmatch .env" \
     --prune-empty --tag-name-filter cat -- --all
   git push origin --force --all
   ```

3. **Generate new secrets** and update `.env`

## ✨ You're Ready!

If all checkboxes are marked and verification steps pass, your code is secure and ready to upload to Git!
