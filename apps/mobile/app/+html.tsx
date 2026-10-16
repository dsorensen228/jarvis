import { ScrollViewStyleReset } from 'expo-router/html';
import { type PropsWithChildren } from 'react';

/**
 * Root HTML for Expo web: keep the viewport from growing past the screen width
 * when inner flex layouts mis-measure (narrow phones / fold cover display).
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        {/* Load before app bundle: Cloud Run / Terraform can override API URL (e.g. ngrok). */}
        <script src="/runtime-env.js" />
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <ScrollViewStyleReset />
        <style
          dangerouslySetInnerHTML={{
            __html: `html,body,#root{max-width:100%;}html{overflow-x:hidden;}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
