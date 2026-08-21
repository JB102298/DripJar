import React, { createContext, useContext, useState } from 'react';
import type { CreateJarRequest } from '@workspace/api-client-react';
import type { DatePrecision } from '@/lib/date-precision';

type CreateJarState = Partial<CreateJarRequest> & {
  milestones?: { name: string; targetAmountCents: number }[];
  invitees?: { email: string; contributionTargetCents?: number }[];
  contributionPlan?: { frequency: any; amountCents: number };
  /**
   * How precisely the organizer actually knows each date.
   *
   * Held in the wizard rather than in component state so stepping back and
   * forth does not silently re-snap an answer to a category default, and so the
   * review screen can render each date at the precision it was given. NOT sent
   * to the API: `jars` stores `YYYY-MM-DD` only, and adding a precision column
   * is a schema change this pass does not make.
   */
  targetDatePrecision?: DatePrecision;
  eventDatePrecision?: DatePrecision;
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
    setState((prev: CreateJarState) => ({ ...prev, ...updates }));
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
