# 🔐 Admin Panel Documentation

## Overview

The bot now includes a comprehensive admin panel accessible only to authorized administrators. The admin panel provides full control over users, statistics, broadcasting, and system management.

## Access Control

Only users with the `ADMIN_CHAT_ID` (set in `.env` file) can access admin features.

## Admin Commands

### Main Commands

#### `/admin`
Opens the main admin panel with an interactive keyboard menu.

**Features:**
- 📊 Statistics
- 👥 User Management
- 📢 Broadcasting
- 💼 Account Management
- 🚫 Blacklist Management
- 🌐 Dashboard Access

#### `/list`
Quick command to list all users with their details.

**Displays:**
- User name (clickable link)
- Telegram username
- Chat ID
- Account statistics
- Blacklist status

### User Management Commands

#### `/ban <user_id> [reason]`
Block a user from using the bot.

**Example:**
```
/ban 123456789 Spam
/ban 987654321
```

**What happens:**
- User is added to blacklist
- User cannot create accounts
- User cannot interact with bot
- Reason is logged for reference

#### `/unban <user_id>`
Remove a user from the blacklist.

**Example:**
```
/unban 123456789
```

### Broadcasting Commands

#### `/broadcast <message>`
Send a message to all non-blacklisted users.

**Example:**
```
/broadcast שלום לכולם! יש לנו עדכון חשוב בשירות
```

**Features:**
- Sends to all active users
- Skips blacklisted users
- Shows delivery statistics
- Includes rate limiting to avoid Telegram restrictions

## Admin Panel Features

### 📊 Statistics View

**Displays:**

**General Statistics:**
- Total users
- Total accounts created
- Active accounts
- Success rate
- Blacklisted users

**Last 24 Hours:**
- Active users
- New accounts created

**Last 7 Days:**
- Active users
- New accounts created

### 👥 User Management

**Features:**
- View all users (paginated)
- See user details:
  - Name and Telegram handle
  - Chat ID
  - Number of accounts (active/total)
  - Blacklist status
- Clickable links to open chat with users

### 📢 Broadcasting

**Features:**
- Send messages to all users
- Automatic blacklist filtering
- Delivery statistics
- Rate limiting protection
- Progress tracking

**Usage:**
1. Click "📢 שידור הודעה" in admin panel
2. Follow instructions to use `/broadcast` command
3. View delivery statistics when complete

### 💼 Account Management

**Displays:**
- Total accounts in system
- Active accounts
- Expired accounts
- Users with accounts
- Average accounts per user
- Active account percentage

### 🚫 Blacklist Management

**Features:**
- View all blacklisted users
- See blacklist reasons
- See when users were blocked
- Ban/unban users with commands

**User Experience for Blacklisted Users:**
- Cannot create new accounts
- Cannot use bot features
- Receives "🚫 אינך יכול להשתמש בבוט זה" message

## Security Features

### Admin Authentication
- Only configured admin can access features
- All admin commands check permissions
- Non-admins receive "⛔ אין לך הרשאות אדמין" message

### Blacklist Protection
- Automatic checking on all user actions
- Prevents account creation
- Blocks all bot interactions
- Maintains blacklist in database

### Audit Trail
- All admin actions are logged
- Blacklist includes:
  - Who added the user
  - When they were added
  - Reason for blocking

## Dashboard Integration

The admin panel works alongside the web dashboard:
- 🌐 Click "Dashboard" button in admin panel
- Opens web interface at `http://localhost:3000`
- Both interfaces share the same database
- Real-time updates via WebSocket

## Database Structure

### Blacklist Entry
```json
{
  "chatId": "123456789",
  "reason": "Spam",
  "addedBy": "987654321",
  "addedAt": "2026-02-11T00:00:00.000Z"
}
```

### Statistics Tracking
All admin actions are tracked in logs for:
- Success rate calculations
- Activity monitoring
- Performance metrics
- Audit trails

## Best Practices

### User Management
1. **Document reasons** - Always provide a reason when banning users
2. **Review regularly** - Periodically review blacklist
3. **Communicate** - Use broadcast to inform users of changes

### Broadcasting
1. **Be concise** - Keep messages short and clear
2. **Test first** - Consider testing with small group
3. **Timing** - Send at appropriate times for your users
4. **Frequency** - Don't spam users with broadcasts

### Security
1. **Protect admin ID** - Keep `ADMIN_CHAT_ID` secure
2. **Review logs** - Regularly check admin dashboard for suspicious activity
3. **Backup data** - Regularly backup `db.json`

## Troubleshooting

### "אין לך הרשאות אדמין"
- Check that your Chat ID matches `ADMIN_CHAT_ID` in `.env`
- Restart the bot after changing `.env`
- Verify environment variables are loaded correctly

### Broadcast not sending
- Check user count with `/list`
- Verify users aren't all blacklisted
- Check bot logs for rate limiting errors

### Statistics not updating
- Statistics update in real-time
- Try clicking "🔙 חזרה לתפריט" and reopening
- Check database file for corruption

## Admin Panel Workflow

1. **Start:** `/admin` - Open main menu
2. **Review:** Check statistics and user activity
3. **Manage:** Ban/unban users as needed
4. **Communicate:** Use broadcast for announcements
5. **Monitor:** Review account statistics
6. **Maintain:** Manage blacklist regularly

## Future Enhancements

Potential features for future updates:
- User groups/categories
- Scheduled broadcasts
- Export statistics to CSV
- Advanced filtering options
- Custom user limits per user
- Analytics dashboard
- Webhook notifications

---

**Version:** 1.0  
**Last Updated:** 2026-02-11  
**Admin Access:** Via `ADMIN_CHAT_ID` environment variable
