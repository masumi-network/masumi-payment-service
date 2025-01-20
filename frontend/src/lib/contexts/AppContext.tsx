/* eslint-disable @typescript-eslint/no-explicit-any */
import { createContext, useContext, useReducer } from 'react';

interface AppState {
  paymentSources: any[];
  contracts: any[];
  wallets: any[];
  apiKey: string | null;
}

type AppAction =
  | { type: 'SET_PAYMENT_SOURCES'; payload: any[] }
  | { type: 'SET_CONTRACTS'; payload: any[] }
  | { type: 'SET_WALLETS'; payload: any[] }
  | { type: 'SET_API_KEY'; payload: string }


const initialAppState: AppState = {
  paymentSources: [],
  contracts: [],
  wallets: [],
  apiKey: null,
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_PAYMENT_SOURCES':
      return {
        ...state,
        paymentSources: action.payload
      };
    case 'SET_CONTRACTS':
      return {
        ...state,
        contracts: action.payload
      };
    case 'SET_WALLETS':
      return {
        ...state,
        wallets: action.payload
      };
    case 'SET_API_KEY':
      return {
        ...state,
        apiKey: action.payload
      };
    default:
      return state;
  }
}

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

interface AppProviderProps {
  children: React.ReactNode;
  initialState: AppState;
}

export function AppProvider({ children, initialState }: AppProviderProps) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  const value = {
    state,
    dispatch
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('Put it in AppProvider');
  }
  return context;
}

export { initialAppState }; 