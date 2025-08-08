import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link
          rel="icon"
          href="https://cdn.prod.website-files.com/67879c5d48bf5ddaad9ec54f/678ee221782a258306985cd4_avatar_img.png"
        />
        <meta
          property="og:title"
          content="Masumi - The Definitive Protocol for AI Agent Networks"
        />
        <meta
          property="og:description"
          content="Empower AI agents with Masumi, a decentralized protocol enabling seamless collaboration and efficient monetization of AI services."
        />
        <meta
          property="twitter:title"
          content="Masumi - The Definitive Protocol for AI Agent Networks"
        />
        <meta
          property="twitter:description"
          content="Empower AI agents with Masumi, a decentralized protocol enabling seamless collaboration and efficient monetization of AI services."
        />
        <meta property="og:image" content="/Admin-dash-light.png" />
        <meta property="twitter:image" content="/Admin-dash-light.png" />
        <meta property="og:url" content="https://masumi.network" />
        <meta property="og:type" content="website" />
      </Head>
      <body className="antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
