# Shoe Store — GitHub + Render Ready

This package is prepared for deployment from GitHub to Render.

## Deploy in a few steps

### 1. Upload to GitHub
Create a new GitHub repository, then upload the contents of this folder.

Do NOT upload `node_modules`, `.env`, or a local SQLite database.

### 2. Deploy on Render
Go to https://render.com, connect GitHub, and create a **New Web Service** from this repository.

Render can also use the included `render.yaml`.

Settings:
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`

The app listens on Render's `PORT` automatically if `server.js` supports it.

### 3. Open the website
After deployment, Render gives you a URL such as:
`https://your-store-name.onrender.com`

### Important demo note
This version still uses SQLite and local uploaded files. That is convenient for a demo, but Render's free/server filesystem is not suitable for reliable long-term product images and database persistence.

For a real store, the next upgrade should move:
- SQLite -> PostgreSQL
- local uploads -> persistent object/image storage
- admin credentials -> environment variables / secure authentication

## Demo products
The app includes five Nike Air Force sample listings that seed into a fresh empty database.
