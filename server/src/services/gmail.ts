import { google } from 'googleapis';

import { prisma } from '../db/client.js';

const GMAIL_SCOPES = [
  // Allows managing drafts and sending messages.
  'https://www.googleapis.com/auth/gmail.compose'
];

function createOAuthClient() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Gmail OAuth environment variables are not fully configured');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// Returns the OAuth consent URL to redirect user to
export function getAuthUrl(): string {
  const oauth2Client = createOAuthClient();

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES
  });
}

// Exchange code for tokens, store refresh_token in DB
export async function handleCallback(code: string, userId: string): Promise<void> {
  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      throw new Error('No refresh_token returned from Gmail OAuth');
    }

    await prisma.user.update({
      where: { id: userId },
      data: { gmailRefreshToken: tokens.refresh_token }
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to exchange Gmail auth code for tokens';
    throw new Error(message);
  }
}

function createGmailClient(refreshToken: string) {
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Core send helper — everything else calls this
export async function sendEmail(
  userId: string,
  to: string,
  subject: string,
  body: string
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.gmailRefreshToken) {
      throw new Error('User does not have a stored Gmail refresh token');
    }

    const gmail = createGmailClient(user.gmailRefreshToken);

    const mime = [
      `To: ${to}`,
      'Content-Type: text/plain; charset=UTF-8',
      `Subject: ${subject}`,
      '',
      body
    ].join('\n');

    const encodedMessage = Buffer.from(mime)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Send the message directly from Gmail.
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send Gmail draft';
    throw new Error(message);
  }
}

