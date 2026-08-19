import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta
          property="og:title"
          content="Masumi - The Definitive Protocol for AI Agent Networks"
        />
        <meta
          property="og:description"
          content="Masumi is a Cardano protocol for paying AI agents. Payments are held in escrow, settled on chain, and disputed through the contract rather than a middleman."
        />
        <meta
          property="twitter:title"
          content="Masumi - The Definitive Protocol for AI Agent Networks"
        />
        <meta
          property="twitter:description"
          content="Masumi is a Cardano protocol for paying AI agents. Payments are held in escrow, settled on chain, and disputed through the contract rather than a middleman."
        />
        <meta
          property="og:image"
          content="https://c-ipfs-gw.nmkr.io/ipfs/QmfHfmxhm2NEBCVNQcRippzEk6SbnH4Wb64u9mGb8cRkve"
        />
        <meta
          property="twitter:image"
          content="https://c-ipfs-gw.nmkr.io/ipfs/QmdVx6LC1842dKuVCivSRg7ApSnt61rkjCJmhXuKTSbXoF"
        />
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
