import React, { createContext, useContext, useState } from 'react';
import type { CreateJarRequest } from '@workspace/api-client-react/src/generated/api.schemas';

type CreateJarState = Partial<CreateJarRequest> & {
  milestones?: { name: string; targetAmountCents: number }[];
  invitees?: { email: string; contributionTargetCents?: number }[];
  contributionPlan?: { frequency: any; amountCents: number };
};

interface CreateJarContextType {
  state: CreateJarState;
  updateState: (updates: Partial<CreateJarState>) => void;
  resetState: () => void;
}

const CreateJarContext = createContext<CreateJarContextType | null>(null);

export function CreateJarProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<CreateJarState>({});

  const updateState = (updates: Partial<CreateJarState>) => {
    setState((prev) => ({ ...prev, ...updates }));
  };

  const resetState = () => setState({});

  return (
    <CreateJarContext.Provider value={{ state, updateState, resetState }}>
      {children}
    </CreateJarContext.Provider>
  );
}

export function useCreateJarContext() {
  const context = useContext(CreateJarContext);
  if (!context) {
    throw new Error('useCreateJarContext must be used within a CreateJarProvider');
  }
  return context;
}
