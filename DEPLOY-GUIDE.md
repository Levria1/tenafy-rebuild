# Tenafy - Digital Ocean Deployment Guide

This guide walks through deploying the Tenafy property management app on Digital Ocean. The MySQL database already lives on an existing Droplet — we clone it first, then deploy the Node.js backend and Next.js frontend pointing at the clone.

A git-based workflow is included so the developer can make changes locally and push them live.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [What You Need Before Starting](#2-what-you-need-before-starting)
3. [Step 1: Clone the Database](#3-step-1-clone-the-database)
4. [Step 2: Create the App Droplet (or reuse existing)](#4-step-2-create-the-app-droplet-or-reuse-existing)
5. [Step 3: Initial Server Setup](#5-step-3-initial-server-setup)
6. [Step 4: Install Dependencies](#6-step-4-install-dependencies)
7. [Step 5: Set Up Git Deployment](#7-step-5-set-up-git-deployment)
8. [Step 6: Deploy the Backend](#8-step-6-deploy-the-backend)
9. [Step 7: Deploy the Frontend](#9-step-7-deploy-the-frontend)
10. [Step 8: Set Up Nginx Reverse Proxy](#10-step-8-set-up-nginx-reverse-proxy)
11. [Step 9: SSL with Let's Encrypt](#11-step-9-ssl-with-lets-encrypt)
12. [Step 10: File Storage Setup](#12-step-10-file-storage-setup)
13. [Step 11: Process Management with PM2](#13-step-11-process-management-with-pm2)
14. [Step 12: Verify Everything Works](#14-step-12-verify-everything-works)
15. [Ongoing Deployments — Push to Go Live](#15-ongoing-deployments--push-to-go-live)
16. [Environment Variables Reference](#16-environment-variables-reference)
17. [Troubleshooting](#17-troubleshooting)
18. [Maintenance](#18-maintenance)

---

## 1. Architecture Overview

```
Internet
   |
   v
[Nginx :80/:443]  ── on App Droplet
   |
   ├── yourdomain.com/*          → Next.js frontend (:3000)
   └── yourdomain.com/api/*      → Express backend  (:3001)
                                        |
                                   [MySQL :3306]
                                   (existing DB Droplet — may be same machine)
                                   Database: tena_prod_v2 (cloned from tena_prod)
```

- **Backend**: Node.js 20 + Express on port 3001
- **Frontend**: Next.js 14 (App Router) on port 3000
- **Database**: MySQL 8.0 on existing Droplet — `tena_prod_v2` (cloned from `tena_prod`)
- **Reverse Proxy**: Nginx handles SSL + routes traffic
- **Process Manager**: PM2 keeps both Node processes alive
- **Deploys**: Push to GitHub → pull on server → restart

---

## 2. What You Need Before Starting

### Accounts / Access

- Digital Ocean account with SSH access to the existing DB Droplet
- A GitHub account (for the deployment workflow)
- A domain name (optional but recommended for SSL)
- SMTP email credentials for production emails (e.g., Gmail App Password, SendGrid, Mailgun)

### Existing Infrastructure

- **DB Droplet IP**: The Droplet that already has MySQL running with the `tena_prod` database
- **MySQL root password** (or a user with enough privileges to clone the database)

### Files on the Dev Machine

The Tenafy Rebuild project lives at `D:\Tane\Tenafy Rebuild\` with:
- `backend/` — Node.js/Express API
- `frontend/` — Next.js 14 app
- `backend/migrations/` — SQL migration files (run after clone)

---

## 3. Step 1: Clone the Database

The live database `tena_prod` already exists on your DB Droplet. We clone it so the new website has its own independent copy.

### SSH into the DB Droplet

```bash
ssh root@DB_DROPLET_IP
```

### Dump the existing database

```bash
mysqldump -u root -p --single-transaction --routines --triggers tena_prod > ~/tena_prod_backup.sql
```

### Create the clone

```bash
# Create the new database
mysql -u root -p -e "CREATE DATABASE tena_prod_v2 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# Import the dump into the clone
mysql -u root -p tena_prod_v2 < ~/tena_prod_backup.sql
```

### Create a MySQL user for the new website

```bash
mysql -u root -p
```

```sql
CREATE USER 'tenafy_v2'@'localhost' IDENTIFIED BY 'PICK_A_STRONG_PASSWORD_HERE';
GRANT ALL PRIVILEGES ON tena_prod_v2.* TO 'tenafy_v2'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

> **If the app runs on a DIFFERENT Droplet than the database**: replace `'localhost'` with the App Droplet's IP address (e.g., `'APP_DROPLET_IP'`), and make sure MySQL is configured to accept remote connections (bind-address in `/etc/mysql/mysql.conf.d/mysqld.cnf` and firewall rules).

### Clean up the dump file (optional)

```bash
rm ~/tena_prod_backup.sql
```

You now have `tena_prod_v2` — a full clone of your production data, ready for the new website.

---

## 4. Step 2: Create the App Droplet (or reuse existing)

**Option A — Same Droplet as the database**: Skip this step. Your app will run alongside MySQL on the same machine. Use `DB_HOST=localhost` in your `.env`.

**Option B — New Droplet**:

1. Log in to Digital Ocean → **Create Droplet**
2. Choose:
   - **Image**: Ubuntu 22.04 LTS
   - **Plan**: Basic, $12/mo (2 GB RAM / 1 vCPU) minimum — $24/mo (4 GB) recommended
   - **Datacenter**: Same region as your DB Droplet for low latency
   - **Authentication**: SSH key (recommended) or password
3. Note the IP address
4. You'll use `DB_HOST=DB_DROPLET_IP` in your `.env` (not localhost)

---

## 5. Step 3: Initial Server Setup

SSH into the App Droplet (or the same DB Droplet if using Option A):

```bash
ssh root@APP_DROPLET_IP
```

Create a non-root user and set up firewall:

```bash
# Create deploy user
adduser tenafy
usermod -aG sudo tenafy

# Set up firewall
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable

# Switch to the new user
su - tenafy
```

---

## 6. Step 4: Install Dependencies

### Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v  # Should show v20.x
npm -v   # Should show 10.x
```

### Nginx

```bash
sudo apt-get install -y nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

### PM2 (Process Manager)

```bash
sudo npm install -g pm2
```

### Git

```bash
sudo apt-get install -y git
```

### Certbot (SSL)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
```

> **Note**: You do NOT need to install MySQL on this server if the database is on a separate Droplet. You only need the `mysql` client if you want to run queries from this machine: `sudo apt-get install -y mysql-client`

---

## 7. Step 5: Set Up Git Deployment

This sets up a GitHub-based workflow: you push changes from your dev machine, then pull them on the server.

### 7a. Create a Private GitHub Repository

1. Go to https://github.com/new
2. Name it something like `tenafy-rebuild` (private repo)
3. Do NOT initialize with README (we'll push existing code)

### 7b. Push the Project from Your Dev Machine

On your local Windows machine:

```bash
cd "D:\Tane\Tenafy Rebuild"

# Make sure .gitignore excludes the right things
# (node_modules, .next, .env should already be ignored)

# Add GitHub as the remote origin
git remote add origin https://github.com/YOUR_USERNAME/tenafy-rebuild.git

# Push everything
git branch -M main
git push -u origin main
```

> If the remote `origin` already exists, use `git remote set-url origin https://github.com/YOUR_USERNAME/tenafy-rebuild.git` instead.

### 7c. Clone the Repo on the Server

SSH into the server as the `tenafy` user:

```bash
su - tenafy
cd ~

# Clone the repo
git clone https://github.com/YOUR_USERNAME/tenafy-rebuild.git tenafy

# If private, GitHub will ask for credentials
# Use a Personal Access Token (PAT) as the password:
# GitHub → Settings → Developer settings → Personal access tokens → Generate new token
# Give it "repo" scope
```

### 7d. Cache Git Credentials on the Server (so you don't re-enter every pull)

```bash
git config --global credential.helper store
# The next time you git pull and enter your PAT, it'll be saved
```

### 7e. Create the Deploy Script

This script automates pulling + building + restarting:

```bash
nano ~/deploy.sh
```

```bash
#!/bin/bash
set -e

echo "=== Tenafy Deploy ==="
echo "Pulling latest code..."
cd ~/tenafy
git pull origin main

echo ""
echo "Installing backend dependencies..."
cd ~/tenafy/backend
npm install --production

echo ""
echo "Installing frontend dependencies..."
cd ~/tenafy/frontend
npm install

echo ""
echo "Building frontend..."
npm run build

echo ""
echo "Running migrations..."
cd ~/tenafy/backend
npm run migrate

echo ""
echo "Restarting services..."
pm2 restart all

echo ""
echo "=== Deploy complete ==="
pm2 status
```

```bash
chmod +x ~/deploy.sh
```

Now deploying is a single command: `~/deploy.sh`

---

## 8. Step 6: Deploy the Backend

### Install dependencies

```bash
cd ~/tenafy/backend
npm install --production
```

### Create the production .env file

This file does NOT go in git — you create it directly on the server:

```bash
nano ~/tenafy/backend/.env
```

Paste this content (edit all values marked with `CHANGE_ME`):

```env
PORT=3001
NODE_ENV=production

# Database — connects to cloned database on DB Droplet
# Use localhost if app + DB are on the same Droplet
# Use the DB Droplet's IP if they're on separate Droplets
DB_HOST=localhost
DB_PORT=3306
DB_USER=tenafy_v2
DB_PASSWORD=CHANGE_ME_DATABASE_PASSWORD
DB_DATABASE=tena_prod_v2

# JWT — generate a random 64-char secret
# Run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=CHANGE_ME_RANDOM_64_CHAR_STRING
JWT_EXPIRES_IN=24h

# Frontend URL — your domain (used in email links + CORS)
FRONTEND_URL=https://yourdomain.com

# Email (SMTP) — required for production email sending
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=CHANGE_ME_your_email@gmail.com
EMAIL_PASS=CHANGE_ME_app_password
EMAIL_FROM=noreply@yourdomain.com

# Legacy file storage path (only if you transferred old uploaded files)
LEGACY_STORAGE_DIR=/home/tenafy/tenafy/storage
```

### IMPORTANT: .env variable names

The backend code reads these exact variable names — do not rename them:

| Variable | Used By | Notes |
|----------|---------|-------|
| `DB_HOST` | `config/index.js` | `localhost` if same Droplet, or DB Droplet IP |
| `DB_PORT` | `config/index.js` | Default: 3306 |
| `DB_USER` | `config/index.js` | The MySQL user you created for the clone |
| `DB_PASSWORD` | `config/index.js` | **NOT** `DB_PASS` — must be `DB_PASSWORD` |
| `DB_DATABASE` | `config/index.js` | **NOT** `DB_NAME` — must be `DB_DATABASE` |
| `JWT_SECRET` | `config/index.js` | Min 32 characters |
| `JWT_EXPIRES_IN` | `config/index.js` | e.g., `24h` |
| `FRONTEND_URL` | `config/index.js` | Full URL with `https://` |
| `EMAIL_HOST` | `config/mailer.js` | SMTP host |
| `EMAIL_PORT` | `config/mailer.js` | Usually 587 |
| `EMAIL_SECURE` | `config/mailer.js` | `false` for port 587, `true` for 465 |
| `EMAIL_USER` | `config/mailer.js` | SMTP username |
| `EMAIL_PASS` | `config/mailer.js` | SMTP password or app password |
| `EMAIL_FROM` | `config/mailer.js` | Sender address |
| `LEGACY_STORAGE_DIR` | `routes/file.js` | Path to migrated file uploads |

### Run migrations

```bash
cd ~/tenafy/backend
npm run migrate
```

The migration runner tracks what's already been applied in a `schema_migrations` table, so it's safe to run repeatedly. It will only apply new migrations.

### Test the backend

```bash
node src/index.js
# Should see: "Server running on port 3001" and "Connected to MySQL database"
# Press Ctrl+C to stop (PM2 will manage it later)
```

---

## 9. Step 7: Deploy the Frontend

```bash
cd ~/tenafy/frontend
npm install
```

### Update the API base URL

The frontend API client needs to point at `/api` (Nginx proxies it to the backend). Check:

```bash
nano ~/tenafy/frontend/src/lib/api.js
```

Look for the Axios `baseURL`. It should be:

```javascript
const api = axios.create({
  baseURL: '/api',  // Nginx proxies this to backend:3001
  // ...
});
```

If it currently uses `http://localhost:3001/api`, change it to just `/api` for production.

### Build for production

```bash
cd ~/tenafy/frontend
npm run build
```

This creates an optimized `.next` build. May take 2-5 minutes.

If out of memory on small Droplets:

```bash
NODE_OPTIONS="--max-old-space-size=1536" npm run build
```

### Test it

```bash
npm start
# Should start on port 3000
# Press Ctrl+C to stop
```

---

## 10. Step 8: Set Up Nginx Reverse Proxy

### Create the Nginx config

```bash
sudo nano /etc/nginx/sites-available/tenafy
```

Paste this config:

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;
    # If no domain yet, use: server_name YOUR_DROPLET_IP;

    # Max upload size (for file uploads)
    client_max_body_size 50M;

    # Backend API
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Frontend (Next.js)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Enable the site

```bash
sudo ln -s /etc/nginx/sites-available/tenafy /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default  # Remove default site
sudo nginx -t  # Test config — should say "syntax is ok"
sudo systemctl reload nginx
```

---

## 11. Step 9: SSL with Let's Encrypt

**Skip this step if you don't have a domain yet.** You can add SSL later.

1. Point your domain's DNS A record to your App Droplet's IP
2. Wait for DNS propagation (5-30 minutes)
3. Run Certbot:

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
# Follow prompts, choose to redirect HTTP → HTTPS
```

Certbot auto-renews. Verify with:

```bash
sudo certbot renew --dry-run
```

---

## 12. Step 10: File Storage Setup

### New uploads

New file uploads go to `~/tenafy/backend/uploads/` automatically (created by the app on first upload).

### Legacy files (from original Tenafy)

If you have the legacy storage files (originally from `D:\Tane\AWS Backup\frontend\tane\storage\`):

```bash
# Transfer from dev machine to server
scp -r "/path/to/storage" tenafy@APP_DROPLET_IP:~/tenafy/storage/

# Make sure LEGACY_STORAGE_DIR in .env points to this path
```

### Permissions

```bash
mkdir -p ~/tenafy/backend/uploads
chmod -R 755 ~/tenafy/backend/uploads/
chmod -R 755 ~/tenafy/storage/  # If legacy files exist
```

---

## 13. Step 11: Process Management with PM2

### Create PM2 ecosystem file

```bash
nano ~/tenafy/ecosystem.config.js
```

```javascript
module.exports = {
  apps: [
    {
      name: 'tenafy-backend',
      cwd: '/home/tenafy/tenafy/backend',
      script: 'src/index.js',
      env: {
        NODE_ENV: 'production'
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M',
      error_file: '/home/tenafy/logs/backend-error.log',
      out_file: '/home/tenafy/logs/backend-out.log',
    },
    {
      name: 'tenafy-frontend',
      cwd: '/home/tenafy/tenafy/frontend',
      script: 'node_modules/.bin/next',
      args: 'start',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M',
      error_file: '/home/tenafy/logs/frontend-error.log',
      out_file: '/home/tenafy/logs/frontend-out.log',
    }
  ]
};
```

### Create log directory and start

```bash
mkdir -p ~/logs
cd ~
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Follow the printed instructions to enable auto-start on reboot
```

### Useful PM2 commands

```bash
pm2 status                    # Check if both apps are running
pm2 logs                      # Tail all logs
pm2 logs tenafy-backend       # Backend logs only
pm2 restart tenafy-backend    # Restart backend
pm2 restart all               # Restart everything
```

---

## 14. Step 12: Verify Everything Works

### Quick checks

```bash
# 1. Check both processes are running
pm2 status

# 2. Test backend directly
curl http://localhost:3001/api/health
# Should return: {"status":"ok","timestamp":"..."}

# 3. Test frontend directly
curl -o /dev/null -w "%{http_code}" http://localhost:3000
# Should return: 200

# 4. Test through Nginx
curl -o /dev/null -w "%{http_code}" http://yourdomain.com
# Should return: 200
```

### Test login

1. Open `https://yourdomain.com` in a browser
2. Log in with: `acjairbnb@gmail.com` / `Test1234`
3. Verify: Dashboard loads with widgets, properties show, invoices list works

### Things to check

- [ ] Login works
- [ ] Dashboard loads with data
- [ ] Properties list shows
- [ ] Invoices list loads
- [ ] Accounting page loads
- [ ] Contacts/Tenants list shows
- [ ] Creating a new invoice works
- [ ] File uploads work (try uploading a document)

---

## 15. Ongoing Deployments — Push to Go Live

This is the workflow for making changes locally and pushing them to the live server.

### The Developer's Daily Workflow

```
 [Dev Machine]                    [GitHub]                    [Server]
      |                              |                           |
  1. Edit code                       |                           |
  2. Test locally                    |                           |
  3. git add + commit                |                           |
  4. git push origin main ---------> |                           |
      |                              |     5. SSH in             |
      |                              |     6. ~/deploy.sh ------>|
      |                              |        (pulls, builds,    |
      |                              |         restarts PM2)     |
```

### Step-by-step:

#### On Your Dev Machine (Windows)

```bash
cd "D:\Tane\Tenafy Rebuild"

# 1. Make your changes (edit backend routes, frontend pages, etc.)

# 2. Test locally
#    Backend:  cd backend && node src/index.js
#    Frontend: cd frontend && npm run dev

# 3. Commit
git add -A
git commit -m "Description of what you changed"

# 4. Push to GitHub
git push origin main
```

#### On the Server

```bash
# SSH into the server
ssh tenafy@APP_DROPLET_IP

# Run the deploy script (created in Step 5e)
~/deploy.sh
```

That's it. The deploy script does: `git pull` → `npm install` → `npm run build` → `npm run migrate` → `pm2 restart all`.

### What the Deploy Script Does (recap)

```bash
#!/bin/bash
set -e
cd ~/tenafy && git pull origin main           # Get latest code
cd ~/tenafy/backend && npm install --production  # Install any new backend packages
cd ~/tenafy/frontend && npm install && npm run build  # Install + rebuild frontend
cd ~/tenafy/backend && npm run migrate           # Apply any new migrations
pm2 restart all                                  # Restart both services
```

### Backend-Only Changes (faster)

If you only changed backend files (no frontend changes), you can skip the frontend build:

```bash
ssh tenafy@APP_DROPLET_IP
cd ~/tenafy
git pull origin main
cd backend && npm install --production
pm2 restart tenafy-backend
```

### Frontend-Only Changes

If you only changed frontend files:

```bash
ssh tenafy@APP_DROPLET_IP
cd ~/tenafy
git pull origin main
cd frontend && npm install && npm run build
pm2 restart tenafy-frontend
```

### Important Notes

- **`.env` is NOT in git** — it stays on the server and is never overwritten by deploys. If you add new env vars, you must manually edit `~/tenafy/backend/.env` on the server.
- **Database migrations are safe to re-run** — the `schema_migrations` table tracks what's been applied.
- **No downtime for backend restarts** — PM2 restarts are near-instant. Frontend rebuilds take 2-5 minutes during which the old build is still serving.
- **If you add new npm packages** — they're in `package.json` which IS in git, so `npm install` in the deploy script picks them up.

---

## 16. Environment Variables Reference

### Backend `.env` — Complete List

```env
# Server
PORT=3001
NODE_ENV=production

# Database (MySQL — the cloned database)
DB_HOST=localhost
DB_PORT=3306
DB_USER=tenafy_v2
DB_PASSWORD=your_strong_password
DB_DATABASE=tena_prod_v2

# Authentication
JWT_SECRET=64_char_random_hex_string
JWT_EXPIRES_IN=24h

# Frontend URL (for email links, CORS)
FRONTEND_URL=https://yourdomain.com

# Email (SMTP)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password
EMAIL_FROM=noreply@yourdomain.com

# File Storage (optional — only if migrating legacy files)
LEGACY_STORAGE_DIR=/home/tenafy/tenafy/storage
```

### Generate a JWT secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Gmail App Password Setup

If using Gmail for SMTP:
1. Go to Google Account → Security → 2-Step Verification (must be on)
2. Go to App passwords → Generate one for "Mail"
3. Use that 16-char password as `EMAIL_PASS`

---

## 17. Troubleshooting

### Backend won't start

```bash
pm2 logs tenafy-backend --lines 50
# Common causes:
# - Wrong DB credentials in .env → check DB_USER / DB_PASSWORD / DB_DATABASE
# - MySQL not running: sudo systemctl status mysql
# - Can't reach DB: check DB_HOST (localhost vs Droplet IP)
# - Port 3001 already in use: lsof -i :3001
```

### Frontend build fails

```bash
cd ~/tenafy/frontend && npm run build
# If out of memory on small droplets:
NODE_OPTIONS="--max-old-space-size=1536" npm run build
```

### Can't connect to MySQL (remote DB Droplet)

If the app and database are on different Droplets:

```bash
# On the DB Droplet — check MySQL is listening on all interfaces:
sudo nano /etc/mysql/mysql.conf.d/mysqld.cnf
# Change: bind-address = 127.0.0.1
# To:     bind-address = 0.0.0.0
sudo systemctl restart mysql

# Also ensure the firewall allows connections from the App Droplet:
sudo ufw allow from APP_DROPLET_IP to any port 3306
```

### Can't connect to MySQL (same Droplet)

```bash
sudo systemctl status mysql
# If not running:
sudo systemctl start mysql

# Test connection with your cloned DB user:
mysql -u tenafy_v2 -p -e "USE tena_prod_v2; SELECT 1;"
```

### Nginx returns 502 Bad Gateway

```bash
# Check if backend/frontend are actually running:
pm2 status

# Check Nginx error logs:
sudo tail -20 /var/log/nginx/error.log
```

### CORS errors in browser

Make sure `FRONTEND_URL` in `.env` matches your actual domain exactly (including `https://`). The backend uses this for CORS.

### Git pull fails on server

```bash
# If there are local changes on the server conflicting with the pull:
cd ~/tenafy
git stash        # Stash any server-side changes
git pull origin main
git stash pop    # Re-apply (if needed), or just drop them: git stash drop
```

### BigInt / Number precision issues

The database uses `supportBigNumbers: true, bigNumberStrings: true`. All BIGINT columns return as strings. This is intentional — JavaScript can't handle 64-bit integers natively. The frontend handles this with `Number()` wrappers where needed.

---

## 18. Maintenance

### Daily deploy workflow

```bash
# On dev machine:
git add -A && git commit -m "your changes" && git push origin main

# On server:
~/deploy.sh
```

### Database backups

Set up a daily cron job on the DB Droplet:

```bash
crontab -e
```

Add:

```
0 3 * * * mysqldump -u tenafy_v2 -pYOUR_PASSWORD --single-transaction tena_prod_v2 > /home/tenafy/backups/tena_prod_v2_$(date +\%Y\%m\%d).sql
```

```bash
mkdir -p ~/backups
```

### Clean up old backups (keep last 30 days)

Add this to crontab too:

```
0 4 * * * find /home/tenafy/backups -name "*.sql" -mtime +30 -delete
```

### Checking logs

```bash
pm2 logs                          # All logs
pm2 logs tenafy-backend           # Backend only
sudo tail -f /var/log/nginx/error.log  # Nginx errors
```

### Updating Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
pm2 restart all
```

---

## Quick Reference — Full Deploy Checklist

### First-Time Setup

```
[ ] 1. Clone database: tena_prod → tena_prod_v2 (on DB Droplet)
[ ] 2. Create MySQL user for the clone (tenafy_v2)
[ ] 3. Set up App Droplet (or reuse existing) with Node.js 20, Nginx, PM2, Git
[ ] 4. Create private GitHub repo, push code from dev machine
[ ] 5. Clone repo on server: git clone → ~/tenafy
[ ] 6. Create backend .env with production values (pointing at tena_prod_v2)
[ ] 7. npm install in both backend/ and frontend/
[ ] 8. Run migrations: cd backend && npm run migrate
[ ] 9. Build frontend: cd frontend && npm run build
[ ] 10. Configure Nginx reverse proxy
[ ] 11. Set up SSL with Certbot (if domain ready)
[ ] 12. Create PM2 ecosystem.config.js and start both apps
[ ] 13. Create ~/deploy.sh script
[ ] 14. Transfer legacy storage files (optional)
[ ] 15. Test login and verify all pages work
[ ] 16. Set up daily database backup cron
```

### Ongoing Deploys

```
[ ] 1. Make changes locally, test
[ ] 2. git add + commit + push origin main
[ ] 3. SSH into server
[ ] 4. Run ~/deploy.sh
[ ] 5. Verify in browser
```
