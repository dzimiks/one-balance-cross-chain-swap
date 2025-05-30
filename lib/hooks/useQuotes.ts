import { useState, useCallback, useRef, useEffect } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { signQuote } from '@/lib/utils/privySigningUtils';
import { Quote, QuoteRequest } from '@/lib/types/quote';
import { quotesApi } from '@/lib/api/quotes';
import { useEmbeddedWallet } from './useEmbeddedWallet';
import { usePredictedAddress } from '@/lib/contexts/PredictedAddressContext';

interface QuoteState {
  quote: Quote | null;
  status: any | null;
  loading: boolean;
  error: string | null;
  isPolling: boolean;
}

// Simple interface for components to use
interface SimpleQuoteRequest {
  fromTokenAmount: string;
  fromAggregatedAssetId: string;
  toAggregatedAssetId: string;
  recipientAddress?: string; // Optional for transfers, should include chain prefix (e.g., "eip155:1:0x...")
}

export const useQuotes = () => {
  const { authenticated } = usePrivy();
  const embeddedWallet = useEmbeddedWallet();
  const { predictedAddress, getPredictedAddress } = usePredictedAddress();
  const statusPollingRef = useRef<NodeJS.Timeout | null>(null);

  const [state, setState] = useState<QuoteState>({
    quote: null,
    status: null,
    loading: false,
    error: null,
    isPolling: false,
  });

  const resetQuote = useCallback(() => {
    // Clear any active polling
    if (statusPollingRef.current) {
      clearInterval(statusPollingRef.current);
      statusPollingRef.current = null;
    }

    setState({
      quote: null,
      status: null,
      loading: false,
      error: null,
      isPolling: false,
    });
  }, []);

  const getQuote = useCallback(
    async (request: SimpleQuoteRequest) => {
      if (!authenticated || !embeddedWallet) {
        setState(prev => ({ ...prev, error: 'Wallet not connected' }));
        return;
      }

      setState(prev => ({ ...prev, loading: true, error: null }));

      try {
        // Get or fetch the predicted address
        let predicted = predictedAddress;
        if (!predicted) {
          predicted = await getPredictedAddress();
          if (!predicted) {
            throw new Error('Failed to get account address');
          }
        }

        const quoteRequest: QuoteRequest = {
          from: {
            account: {
              sessionAddress: embeddedWallet.address,
              adminAddress: embeddedWallet.address,
              accountAddress: predicted,
            },
            asset: {
              assetId: request.fromAggregatedAssetId,
            },
            amount: request.fromTokenAmount,
          },
          to: {
            asset: {
              assetId: request.toAggregatedAssetId,
            },
            // Add recipient account for transfers (should already include chain prefix)
            ...(request.recipientAddress && {
              account: request.recipientAddress,
            }),
          },
        };

        // Get the quote
        const quote = await quotesApi.getQuote(quoteRequest);

        setState(prev => ({ ...prev, quote, loading: false }));
        return quote;
      } catch (err) {
        setState(prev => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Failed to get quote',
          loading: false,
        }));
      }
    },
    [authenticated, embeddedWallet, predictedAddress, getPredictedAddress]
  );

  const executeQuote = useCallback(async () => {
    if (!authenticated || !embeddedWallet) {
      setState(prev => ({ ...prev, error: 'Wallet not connected' }));
      return;
    }

    if (!state.quote) {
      setState(prev => ({ ...prev, error: 'No quote to execute' }));
      return;
    }

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      // Validate the quote hasn't expired
      const expirationTime = parseInt(state.quote.expirationTimestamp) * 1000;
      if (Date.now() > expirationTime) {
        setState(prev => ({
          ...prev,
          error: 'Quote has expired',
          loading: false,
        }));
        return;
      }

      // Sign the quote with Privy
      const signedQuote = await signQuote(state.quote, embeddedWallet);

      // Execute the signed quote
      await quotesApi.executeQuote(signedQuote);

      // Start polling for status immediately after execution
      setState(prev => ({ ...prev, isPolling: true }));

      // Clear any existing polling
      if (statusPollingRef.current) {
        clearInterval(statusPollingRef.current);
      }

      statusPollingRef.current = setInterval(async () => {
        try {
          const statusResponse = await quotesApi.getQuoteStatus(state.quote!.id);
          setState(prev => ({ ...prev, status: statusResponse }));

          // If the transaction is completed or failed, stop polling
          if (statusResponse?.status === 'COMPLETED' || statusResponse?.status === 'FAILED') {
            if (statusPollingRef.current) {
              clearInterval(statusPollingRef.current);
              statusPollingRef.current = null;
            }
            setState(prev => ({ ...prev, loading: false, isPolling: false }));
          }
        } catch (err) {
          console.error('Error polling transaction status:', err);
          if (statusPollingRef.current) {
            clearInterval(statusPollingRef.current);
            statusPollingRef.current = null;
          }
          setState(prev => ({
            ...prev,
            error: err instanceof Error ? err.message : 'Failed to get status',
            loading: false,
            isPolling: false,
          }));
        }
      }, 1000); // Poll every 1 second
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to execute quote',
        loading: false,
      }));
    }
  }, [state.quote, authenticated, embeddedWallet]);

  useEffect(() => {
    return () => {
      if (statusPollingRef.current) {
        clearInterval(statusPollingRef.current);
      }
    };
  }, []);

  return {
    quote: state.quote,
    status: state.status,
    loading: state.loading,
    error: state.error,
    isPolling: state.isPolling,
    predictedAddress,
    getPredictedAddress,
    getQuote,
    executeQuote,
    resetQuote,
  };
};
