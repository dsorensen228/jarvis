import React, { useMemo } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { buildResearchReportDocument } from '../../lib/researchReport';

export interface ResearchReportViewProps { html: string; }

export function ResearchReportView({ html }: ResearchReportViewProps) {
  const { colors, colorScheme } = useTheme();
  const document = useMemo(() => buildResearchReportDocument(html, colors, colorScheme, 'Research report', 'about:srcdoc'), [html, colors, colorScheme]);
  return <iframe
    title="Research report"
    srcDoc={document}
    sandbox="allow-popups allow-popups-to-escape-sandbox"
    referrerPolicy="no-referrer"
    style={{ flex: 1, width: '100%', height: '100%', minHeight: 0, border: 0, backgroundColor: colors.surface }}
  />;
}
