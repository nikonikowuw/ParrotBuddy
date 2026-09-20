import { useCallback, useEffect, useRef, useState } from "react";

import { fetchSkills } from "@/lib/api";
import type { SkillSummary } from "@/lib/types";

interface UseSkillsResult {
  skills: SkillSummary[];
  refresh: () => Promise<void>;
}

export function useSkills(token: string): UseSkillsResult {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestSequence.current;
    const { skills: nextSkills } = await fetchSkills(token);
    if (requestId === requestSequence.current) setSkills(nextSkills);
  }, [token]);

  useEffect(() => {
    void refresh().catch(() => undefined);
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh]);

  return { skills, refresh };
}
