declare module '@transak/transak-sdk' {
  export interface TransakEventData {
    eventName: string;
    status: string;
    [key: string]: unknown;
  }

  export interface TransakConfig {
    apiKey: string;
    environment: string;
    defaultCryptoCurrency: string;
    walletAddress: string;
    defaultNetwork: string;
    cryptoCurrencyList: string;
    defaultPaymentMethod?: string;
    exchangeScreenTitle?: string;
    hideMenu?: boolean;
    themeColor?: string;
    hostURL?: string;
    widgetHeight?: string;
    widgetWidth?: string;
  }

  export class Transak {
    static ENVIRONMENTS: {
      STAGING: string;
      PRODUCTION: string;
    };

    static EVENTS: {
      TRANSAK_WIDGET_CLOSE: string;
      TRANSAK_WIDGET_CLOSE_REQUEST: string;
      TRANSAK_ORDER_SUCCESSFUL: string;
      TRANSAK_ORDER_FAILED: string;
      TRANSAK_ORDER_CREATED: string;
      TRANSAK_EXIT_CONFIRM: string;
      TRANSAK_WIDGET_MODAL_CLOSE: string;
    };

    // Static method for event listeners (SDK v2)
    static on(event: string, callback: (data: TransakEventData) => void): void;

    constructor(config: TransakConfig);

    init(): void;
    close(): void;
  }

  export { Transak };
}
