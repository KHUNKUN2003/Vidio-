# Vidio+

Vidio+ is a private YouTube video viewer built with React, Vite, Express, and PostgreSQL. It includes an admin dashboard for managing videos and a user login flow with phone OTP or LINE Login membership approval.

## Features

- Login-first experience with separated Admin and User roles
- Admin dashboard for adding, editing, deleting, toggling visibility, and reordering videos
- YouTube embed viewer with sharing/navigation controls visually blocked as much as the YouTube iframe allows
- Phone OTP demo login with JWT sessions
- LINE Login membership requests with admin approval/rejection
- Single active user session protection for phone and LINE accounts
- Neon PostgreSQL support
- Toast notifications, confirm dialogs, skeleton loading, and a clean Apple-inspired UI

## Tech Stack

- React 19
- Vite
- Express 5
- PostgreSQL via `pg`
- JWT-style HMAC tokens
- LINE Login OAuth

## Deployments

Primary production runs on Railway because realtime Server-Sent Events need a long-running server:

```txt
https://vidio-plus-production.up.railway.app
```

The old Vercel URL redirects to Railway:

```txt
https://vidio-plus.vercel.app
```

## Getting Started

Install dependencies:

```bash
npm install
```

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Set your environment variables:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/course_video_dashboard
DATABASE_SSL=false
PORT=4174
JWT_SECRET=change-this-to-a-long-random-secret
CLIENT_URL=http://127.0.0.1:5173
LINE_CHANNEL_ID=
LINE_CHANNEL_SECRET=
LINE_CALLBACK_URL=http://127.0.0.1:4174/api/auth/line/callback
```

Run the app:

```bash
npm run dev
```

Open:

```txt
http://127.0.0.1:5173
```

## Admin Login

Default admin credentials are configured in `admin-utils.mjs`.

```txt
username: admin
password: @admin_123
```

For production, replace this with a real user table and hashed passwords.

## LINE Login Setup

Create a LINE Login channel in LINE Developers Console, then add this callback URL:

```txt
http://127.0.0.1:4174/api/auth/line/callback
```

For production, use the Railway callback URL:

```txt
https://vidio-plus-production.up.railway.app/api/auth/line/callback
```

Use the LINE Login channel values in `.env`:

```env
LINE_CHANNEL_ID=your-line-login-channel-id
LINE_CHANNEL_SECRET=your-line-login-channel-secret
```

Do not use Messaging API channel credentials for LINE Login.

## Database

The server initializes the required tables automatically on startup using `server/schema.sql`.

Main tables:

- `videos`
- `user_sessions`
- `membership_requests`

Neon PostgreSQL works by setting `DATABASE_URL` to your Neon connection string.
For Neon deployments, set `DATABASE_SSL=true`.

## Scripts

```bash
npm run dev
npm run dev:client
npm run dev:server
npm run build
npm run preview
npm test
```

## Security Notes

- Never commit `.env`.
- Rotate any secrets that were shared in chat or exposed during setup.
- The phone OTP flow is currently a demo flow that returns `demoOtp` from the API.
- YouTube embeds cannot be made fully private by hiding buttons alone. For stronger protection, use private video hosting or signed playback URLs.

## Project Structure

```txt
server/              Express API and database schema
src/                 React app and styles
tests/               Domain tests
*.mjs                Shared domain utilities
.env.example         Environment template
```
