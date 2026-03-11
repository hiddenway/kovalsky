import * as Sentry from "@sentry/nextjs";

const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN
  || "https://c99b25b5ddb9e5dc0dcc5e22f7a93f2a@o4511024995631104.ingest.us.sentry.io/4511024997597184";

Sentry.init({
  dsn: sentryDsn,
  enabled: Boolean(sentryDsn),
  tracesSampleRate: 1,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
