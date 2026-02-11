# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please email the repository maintainer directly. Do not open a public issue.

## Security Best Practices

### Before Deploying

1. **Never commit sensitive files**
   - `.env` files
   - `db.json` database
   - Any files with tokens, passwords, or user data

2. **Rotate secrets regularly**
   - Change your Telegram bot token periodically
   - Generate new API keys if compromised

3. **Review commits before pushing**
   - Check for accidentally committed secrets
   - Use `git status` and `git diff` before committing

4. **Use environment variables**
   - All secrets should be in `.env` file
   - Never hardcode tokens in source code

### If You Accidentally Committed Secrets

1. **Immediately revoke the exposed credentials**
   - For Telegram bots: Talk to @BotFather and revoke/regenerate token
   
2. **Remove from Git history** (if already pushed)
   ```bash
   # Remove file from Git history
   git filter-branch --force --index-filter \
     "git rm --cached --ignore-unmatch .env" \
     --prune-empty --tag-name-filter cat -- --all
   
   # Force push to remote (WARNING: This rewrites history)
   git push origin --force --all
   ```

3. **Update .gitignore** to prevent future accidents

4. **Generate new secrets** and update `.env`

## Secure Configuration Checklist

- [ ] `.env` file created and populated
- [ ] `.gitignore` includes `.env` and `db.json`
- [ ] No hardcoded tokens in source code
- [ ] Strong admin access controls
- [ ] Database file excluded from Git
- [ ] Regular backups of `db.json` (stored securely)

## Production Deployment

### Additional Security Measures

1. **Use HTTPS**
   - Set up SSL/TLS certificates
   - Use reverse proxy (nginx, Apache)

2. **Implement rate limiting**
   - Prevent abuse of bot commands
   - Limit API endpoint requests

3. **Set up monitoring**
   - Log suspicious activities
   - Alert on unusual patterns

4. **Database security**
   - Regular backups
   - Encrypt sensitive data
   - Restrict file permissions

5. **Server hardening**
   - Use firewall rules
   - Keep Node.js updated
   - Disable unnecessary services
   - Use non-root user for running the app

## Dependencies

Run `npm audit` regularly to check for vulnerable dependencies:

```bash
npm audit
npm audit fix
```

## Webhooks vs Polling

For production, consider using webhooks instead of polling:
- More efficient
- Faster response times
- Lower server load
- Better security (requires HTTPS)

## Data Privacy

- Comply with GDPR and local data protection laws
- Implement data retention policies
- Allow users to request data deletion
- Store only necessary user information

## Access Control

- Limit admin dashboard access by IP or authentication
- Use strong passwords for any admin interfaces
- Implement session management
- Log all admin actions

## Regular Security Updates

1. Keep dependencies updated: `npm update`
2. Review security advisories
3. Monitor GitHub security alerts
4. Test updates in development first

---

**Last Updated**: 2026-02-11
