import { MainLayout } from '@/components/layout/MainLayout';
import Head from 'next/head';

export default function OpenAPI() {

    const docsUrl =
        typeof window !== 'undefined' ? `${window.location.origin}/docs` : '/docs';

    return (
        <MainLayout>
            <Head>
                <title>OpenAPI Documentation | Admin Interface</title>
            </Head>
            <div className="flex flex-col h-[calc(100vh-120px)]">
                <div className="mb-4">
                    <h1 className="text-xl font-semibold mb-1">OpenAPI Documentation</h1>
                    <p className="text-sm text-muted-foreground">
                        Interactive API documentation powered by Swagger UI.{' '}
                        <a
                            href="/docs"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                        >
                            Open in new tab
                        </a>
                    </p>
                </div>
                <div className="flex-1 border rounded-lg overflow-hidden">
                    <iframe
                        src={docsUrl}
                        className="w-full h-full"
                        title="OpenAPI Documentation"
                    />
                </div>
            </div>
        </MainLayout>
    );
}
