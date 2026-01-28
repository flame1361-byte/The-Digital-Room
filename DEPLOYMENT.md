# TheDigitalRoom - Production Deployment Guide

## Quick Start for Render.com

### Step 1: Generate Secure Secrets

Run this locally to generate a strong JWT_SECRET:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output - you'll need it in Step 3.

### Step 2: Push Code to GitHub

```bash
git add .
git commit -m "Security: Add Helmet.js, rate limiting, and input validation"
git push origin main
```

### Step 3: Deploy to Render

1. Go to [render.com](https://render.com)
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name:** `thedigitalroom`
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Region:** Choose closest to users

5. Add Environment Variables (Settings → Environment):
   ```
   JWT_SECRET=<paste-generated-secret-from-step-1>
   ADMIN_USER=mayne
   ALLOWED_ORIGINS=https://yourdomain.onrender.com
   NODE_ENV=production
   PORT=3000
   ```

6. Click "Create Web Service"

### Step 4: Verify Deployment

Once live, test:

```bash
# Check server is running
curl https://yourdomain.onrender.com/health

# Verify security headers
curl -I https://yourdomain.onrender.com

# Should see headers like:
# Strict-Transport-Security: max-age=31536000
# Content-Security-Policy: ...
# X-Frame-Options: DENY
```

---

## Environment Variables Reference

| Variable | Required | Example | Notes |
|----------|----------|---------|-------|
| `JWT_SECRET` | ✅ YES | `a1b2c3d4...` | Min 32 chars, use cryptography |
| `ADMIN_USER` | ✅ YES | `mayne` | First registered account gets all roles |
| `ALLOWED_ORIGINS` | ✅ YES | `https://yourdomain.com` | Your production domain |
| `NODE_ENV` | ❌ Optional | `production` | Set to production in live |
| `PORT` | ❌ Optional | `3000` | Render assigns port automatically |
| `DATABASE_PATH` | ❌ Optional | `/opt/render/data/users.db` | Render free tier loses data on restart |

---

## Post-Deployment Checklist

- [ ] Server running without errors: `curl https://yourdomain.com/health`
- [ ] HTTPS working: URL shows lock icon in browser
- [ ] Security headers present: `curl -I https://yourdomain.com | grep -i "strict-transport"`
- [ ] Login works: Register test account
- [ ] DJ mode works: Claim DJ, load SoundCloud track
- [ ] Chat works: Send messages in real-time
- [ ] Admin commands work (if admin user): Send announcement

---

## Monitoring & Maintenance

### Weekly
- [ ] Check error logs: `Render Dashboard → Logs`
- [ ] Verify disk space usage

### Monthly
- [ ] Run `npm audit` for dependency updates
- [ ] Check for Node.js security advisories
- [ ] Review active user connections

### Quarterly
- [ ] Rotate JWT_SECRET (requires re-login for all users)
- [ ] Update dependencies: `npm update`
- [ ] Security audit review

---

## Troubleshooting

### Server won't start
```bash
# Check server logs
# Error message: "Missing required environment variables"
# → You forgot to set JWT_SECRET or ADMIN_USER in Render
```

### 503 Service Unavailable
```bash
# Server crashed or not responding
# Check Render logs for errors
# Common: Missing environment variables, database permission issues
```

### Users getting disconnected frequently
```bash
# Could be rate limiting
# Check: Are users sending >10 events/second?
# Increase MAX_EVENTS_PER_WINDOW in server.js if needed
```

### CORS errors in console
```bash
# Your domain not in ALLOWED_ORIGINS
# Update in Render Settings → Environment
# Example: https://yourdomain.onrender.com,https://yourdomain.com
```

---

## Security Reminders

⚠️ **NEVER:**
- Commit `.env` file with real secrets to Git
- Share JWT_SECRET publicly
- Use default passwords in production
- Disable HTTPS
- Run production code in development mode

✅ **ALWAYS:**
- Rotate JWT_SECRET if compromised
- Monitor error logs daily
- Update dependencies monthly
- Use strong, unique ADMIN_USER password
- Test in staging before production changes

---

## Rolling Back to Previous Version

If something breaks after deploying:

1. In Render Dashboard, go to "Deploys"
2. Find previous working deployment
3. Click "Redeploy"
4. Confirm and wait for deployment to complete

---

## Database Persistence on Render Free Tier

⚠️ Important: Render Free Tier resets your application and deletes data on every deployment!

**Solution:**
- Upgrade to Render Paid ($7/month)
- OR use Render PostgreSQL database (separate service)
- OR migrate to Replit, Railway, or similar

To use Render PostgreSQL:
1. Create PostgreSQL database in Render
2. Migrate NeDB to PostgreSQL (requires code changes)
3. Update DATABASE_PATH in environment

---

## Need Help?

1. Check [SECURITY.md](SECURITY.md) for security-specific issues
2. Review [README.md](README.md) for feature documentation
3. Check [CODE_REVIEW.md](CODE_REVIEW.md) for known issues
4. Server logs in Render Dashboard under "Logs"

**Last Updated:** January 28, 2026
