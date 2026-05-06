import { useQuery, useQueryClient } from "@tanstack/react-query";
import { 
  useCreateHolding,
  useUpdateHolding,
  useDeleteHolding,
  useRefreshPrices,
  useGetPortfolioSummary,
  getListHoldingsQueryKey,
  getGetPortfolioSummaryQueryKey,
  getListSnapshotsQueryKey,
  type Holding,
} from "@workspace/api-client-react";
import { useToast } from "./use-toast";
import type { SnapshotRange } from "@/pages/assets/types";

export type PortfolioSnapshot = {
  id: number;
  totalValue: number;
  stockValue: number;
  goldValue: number;
  typeValues: Record<string, number>;
  snapshotAt: string;
};

async function fetchHoldings(): Promise<Holding[]> {
  const res = await fetch("/api/holdings");
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchSnapshots(range: SnapshotRange): Promise<PortfolioSnapshot[]> {
  const res = await fetch(`/api/snapshots?range=${encodeURIComponent(range)}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function usePortfolioData(snapshotRange: SnapshotRange = "1m") {
  const holdingsQuery = useQuery({
    queryKey: getListHoldingsQueryKey(),
    queryFn: fetchHoldings,
  });
  const summaryQuery = useGetPortfolioSummary();
  const snapshotsQuery = useQuery({
    queryKey: [...getListSnapshotsQueryKey(), snapshotRange],
    queryFn: () => fetchSnapshots(snapshotRange),
  });

  const isLoading = holdingsQuery.isLoading || summaryQuery.isLoading || snapshotsQuery.isLoading;
  const isError = holdingsQuery.isError || summaryQuery.isError || snapshotsQuery.isError;
  const error = holdingsQuery.error || summaryQuery.error || snapshotsQuery.error;

  return {
    holdings: holdingsQuery.data || [],
    summary: summaryQuery.data,
    snapshots: snapshotsQuery.data || [],
    isLoading,
    isError,
    error,
  };
}

export function usePortfolioMutations() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getListHoldingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListSnapshotsQueryKey() });
  };

  const createHolding = useCreateHolding({
    mutation: {
      onSuccess: () => {
        toast({ title: "Asset Added", description: "Successfully added to your portfolio." });
        invalidateAll();
      },
      onError: (error: any) => {
        toast({ title: "Error", description: error?.message || "Failed to add asset.", variant: "destructive" });
      }
    }
  });

  const updateHolding = useUpdateHolding({
    mutation: {
      onSuccess: () => {
        toast({ title: "Asset Updated", description: "Successfully updated quantity." });
        invalidateAll();
      },
      onError: (error: any) => {
        toast({ title: "Error", description: error?.message || "Failed to update asset.", variant: "destructive" });
      }
    }
  });

  const deleteHolding = useDeleteHolding({
    mutation: {
      onSuccess: () => {
        toast({ title: "Asset Removed", description: "Successfully removed from portfolio." });
        invalidateAll();
      },
      onError: (error: any) => {
        toast({ title: "Error", description: error?.message || "Failed to remove asset.", variant: "destructive" });
      }
    }
  });

  const refreshPrices = useRefreshPrices({
    mutation: {
      onSuccess: () => {
        toast({ title: "Prices Synchronized", description: "Latest market data fetched successfully." });
        invalidateAll();
      },
      onError: (error: any) => {
        toast({ title: "Sync Failed", description: error?.message || "Could not fetch latest prices.", variant: "destructive" });
      }
    }
  });

  return {
    createHolding,
    updateHolding,
    deleteHolding,
    refreshPrices
  };
}
