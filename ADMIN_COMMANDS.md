# 🔐 Admin Commands Guide

## Setup

1. Get your Chat ID: `/getid`
2. Set `ADMIN_CHAT_ID` in Zeabur environment variables
3. Redeploy the service

## Commands

### Main Admin Panel
```
/admin - Open admin panel
```

### Statistics
```
/stats - View system statistics
- Total users
- Accounts created
- Active accounts
- Success rate
- Blacklisted users
- Activity for last 24h and 7 days
```

### User Management
```
/users - List all users
- Shows all registered users
- Displays active/blocked status
- Shows account counts per user
```

### Blacklist Management
```
/blacklist - View blacklisted users
- Shows all blocked users
- Displays block reason
- Shows block timestamp
```

### Account Management
```
/accounts - View all accounts statistics
- Total accounts created
- Active vs expired accounts
- Users with accounts
- Average accounts per user
```

### Broadcast Messages
```
/broadcast - Send message to all users
Note: Use the command to start the broadcast flow
```

## Button-Based Admin Panel

If you prefer buttons, send `/admin` or click the 🔐 button in `/start`

The admin panel includes:
- 📊 Statistics
- 👥 Users (with quick actions)
- 📢 Broadcast message
- 💼 Accounts overview
- 🚫 Blacklist management
- 🌐 Dashboard link

## Troubleshooting

### Admin button not working?
1. Check Zeabur logs for errors
2. Verify `ADMIN_CHAT_ID` is set correctly
3. Use command alternatives instead: `/admin`, `/stats`, etc.
4. Send `/getid` to verify your admin status

### Commands not responding?
1. Verify you're the admin user
2. Check if the bot is running on Zeabur
3. Look at Zeabur deployment logs

## Security Notes

⚠️ **Important:**
- Only the Chat ID set in `ADMIN_CHAT_ID` has admin access
- All admin commands and buttons check permission first
- Unauthorized users receive "⛔ אין לך הרשאות" message
