import React, { useMemo, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useTheme } from '../../contexts/ThemeContext';
import { buildResearchReportDocument, isExternalReportUrl, isLocalReportUrl } from '../../lib/researchReport';

export interface ResearchReportViewProps { html: string; }

/** Android viewer. The web build resolves ResearchReportView.web.tsx instead. */
export function ResearchReportView({ html }: ResearchReportViewProps) {
  const { colors, colorScheme } = useTheme();
  const [linkError, setLinkError] = useState<string | null>(null);
  const document = useMemo(() => buildResearchReportDocument(html, colors, colorScheme), [html, colors, colorScheme]);
  const openLink = (url: string) => {
    if (!isExternalReportUrl(url)) return;
    setLinkError(null);
    void Linking.openURL(url).catch(() => setLinkError('Could not open this source link.'));
  };
  return (
    <View style={styles.fill}>
      {linkError && <Text accessibilityRole="alert" style={{ color: colors.error, padding: 12 }}>{linkError}</Text>}
      <WebView
        source={{ html: document }}
        style={[styles.fill, { backgroundColor: colors.surface }]}
        originWhitelist={['*']}
        javaScriptEnabled={false}
        javaScriptCanOpenWindowsAutomatically={false}
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        geolocationEnabled={false}
        mixedContentMode="never"
        setSupportMultipleWindows
        onOpenWindow={({ nativeEvent }) => openLink(nativeEvent.targetUrl)}
        onShouldStartLoadWithRequest={({ url }) => {
          if (isLocalReportUrl(url)) return true;
          openLink(url);
          return false;
        }}
        renderError={() => <Text style={{ color: colors.error, padding: 20 }}>Could not display this report. Close it and try again.</Text>}
      />
    </View>
  );
}
const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
