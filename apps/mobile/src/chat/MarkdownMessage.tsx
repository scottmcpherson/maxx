import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  CodeBlock,
  Markdown,
  MarkdownStream,
  useMarkdownSession,
  type CodeBlockRendererProps,
  type CustomRenderers,
  type MarkdownErrorPhase,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";

import { colors } from "../theme";
import {
  resolveMarkdownLinkAction,
  resolveMarkdownSessionUpdate,
} from "./markdownModel";

const MARKDOWN_OPTIONS = {
  gfm: true,
  html: false,
  math: false,
} as const;

const MARKDOWN_THEME: PartialMarkdownTheme = {
  colors: {
    text: colors.text,
    textMuted: colors.secondary,
    heading: colors.text,
    link: colors.accent,
    code: colors.text,
    codeBackground: colors.elevated,
    codeLanguage: colors.tertiary,
    blockquote: colors.accent,
    border: colors.borderStrong,
    surface: "transparent",
    surfaceLight: colors.elevatedSoft,
    accent: colors.accent,
    tableBorder: colors.borderStrong,
    tableHeader: colors.elevatedSoft,
    tableHeaderText: colors.text,
    tableRowEven: "transparent",
    tableRowOdd: "rgba(255,255,255,0.025)",
    codeTokenColors: {
      keyword: "#C792EA",
      string: "#C3E88D",
      comment: colors.tertiary,
      number: "#F78C6C",
      operator: "#89DDFF",
      punctuation: colors.secondary,
      type: "#FFCB6B",
      default: colors.text,
    },
  },
  spacing: {
    xs: 4,
    s: 6,
    m: 10,
    l: 14,
    xl: 20,
  },
  fontSizes: {
    xs: 11,
    s: 13,
    m: 16,
    l: 18,
    xl: 21,
    h1: 22,
    h2: 20,
    h3: 18,
    h4: 17,
    h5: 16,
    h6: 15,
  },
  fontFamilies: {
    mono: Platform.select({ ios: "Menlo", default: "monospace" }),
  },
  headingWeight: "700",
  borderRadius: {
    s: 5,
    m: 10,
    l: 13,
  },
  showCodeLanguage: false,
};

const MARKDOWN_STYLES: NodeStyleOverrides = {
  document: { flexShrink: 1 },
  paragraph: { marginTop: 0, marginBottom: 10 },
  text: { lineHeight: 23 },
  heading: { marginTop: 12, marginBottom: 7 },
  list: { marginTop: 1, marginBottom: 9 },
  list_item: { marginBottom: 3 },
  task_list_item: { marginBottom: 3 },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.accent,
    paddingLeft: 11,
    marginVertical: 8,
  },
  horizontal_rule: {
    backgroundColor: colors.borderStrong,
    marginVertical: 12,
  },
};

function MarkdownCodeBlock({ content, language }: CodeBlockRendererProps) {
  const languageLabel = language?.trim() || "text";
  const { copied, copy } = useCopyFeedback(content);

  return (
    <View style={markdownStyles.codeCard}>
      <View style={markdownStyles.codeHeader}>
        <Text numberOfLines={1} style={markdownStyles.codeLanguage}>
          {languageLabel}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? "Code copied" : "Copy code"}
          hitSlop={8}
          onPress={copy}
          style={({ pressed }) => [markdownStyles.copyButton, pressed && markdownStyles.pressed]}
        >
          <SymbolView
            name={copied ? "checkmark" : "doc.on.doc"}
            size={14}
            tintColor={copied ? colors.success : colors.secondary}
          />
        </Pressable>
      </View>
      <CodeBlock
        content={content.replace(/\n$/u, "")}
        language={language}
        style={markdownStyles.codeBody}
      />
    </View>
  );
}

const MARKDOWN_RENDERERS: CustomRenderers = {
  code_block: MarkdownCodeBlock,
};

async function handleMarkdownLinkPress(href: string): Promise<boolean> {
  const action = resolveMarkdownLinkAction(href);
  if (action.kind === "block") {
    Alert.alert("Link unavailable", "Maxx Mobile only opens safe external links.");
    return false;
  }

  try {
    if (!(await Linking.canOpenURL(action.href))) {
      Alert.alert("Link unavailable", "This device cannot open that link.");
      return false;
    }
    await Linking.openURL(action.href);
  } catch {
    Alert.alert("Link unavailable", "The link could not be opened.");
  }
  return false;
}

function handleMarkdownStreamError(error: Error, phase: MarkdownErrorPhase) {
  console.warn(`[maxx-markdown-stream] ${phase}`, error);
}

function MarkdownFallback({ markdown }: { markdown: string }) {
  return (
    <Text selectable style={markdownStyles.fallbackText}>
      {markdown}
    </Text>
  );
}

function useCopyFeedback(value: string) {
  const [copied, setCopied] = useState(false);
  const activeRef = useRef(true);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
      }
    };
  }, []);

  const copy = useCallback(() => {
    void Clipboard.setStringAsync(value)
      .then(() => {
        if (!activeRef.current) return;
        setCopied(true);
        void Haptics.selectionAsync().catch(() => undefined);
        if (clearTimerRef.current !== null) {
          clearTimeout(clearTimerRef.current);
        }
        clearTimerRef.current = setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => {
        if (activeRef.current) {
          Alert.alert("Copy unavailable", "The text could not be copied.");
        }
      });
  }, [value]);

  return { copied, copy };
}

function CopyResponseButton({ markdown }: { markdown: string }) {
  const { copied, copy } = useCopyFeedback(markdown);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? "Response copied" : "Copy response"}
      hitSlop={8}
      onPress={copy}
      style={({ pressed }) => [
        markdownStyles.responseCopyButton,
        pressed && markdownStyles.pressed,
      ]}
    >
      <SymbolView
        name={copied ? "checkmark" : "doc.on.doc"}
        size={13}
        tintColor={copied ? colors.success : colors.tertiary}
      />
      <Text style={[markdownStyles.responseCopyLabel, copied && markdownStyles.copiedLabel]}>
        {copied ? "Copied" : "Copy"}
      </Text>
    </Pressable>
  );
}

export const AssistantMarkdown = memo(function AssistantMarkdown({
  markdown,
}: {
  markdown: string;
}) {
  const [failedMarkdown, setFailedMarkdown] = useState<string | null>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const handleError = useCallback(
    (error: Error, phase: MarkdownErrorPhase) => {
      console.warn(`[maxx-markdown] ${phase}`, error);
      queueMicrotask(() => {
        if (activeRef.current) setFailedMarkdown(markdown);
      });
    },
    [markdown],
  );

  return (
    <View style={markdownStyles.document}>
      {failedMarkdown === markdown ? (
        <MarkdownFallback markdown={markdown} />
      ) : (
        <Markdown
          highlightCode
          onError={handleError}
          onLinkPress={handleMarkdownLinkPress}
          options={MARKDOWN_OPTIONS}
          renderers={MARKDOWN_RENDERERS}
          styles={MARKDOWN_STYLES}
          theme={MARKDOWN_THEME}
        >
          {markdown}
        </Markdown>
      )}
      <CopyResponseButton markdown={markdown} />
    </View>
  );
});

export const StreamingAssistantMarkdown = memo(function StreamingAssistantMarkdown({
  markdown,
}: {
  markdown: string;
}) {
  const [failed, setFailed] = useState(false);
  const activeRef = useRef(true);
  const initialMarkdownRef = useRef(markdown);
  const previousMarkdownRef = useRef(markdown);
  const session = useMarkdownSession(initialMarkdownRef.current);
  const { getSession, reset } = session;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    const update = resolveMarkdownSessionUpdate(previousMarkdownRef.current, markdown);
    previousMarkdownRef.current = markdown;
    if (update.kind === "append") {
      getSession().append(update.text);
    } else if (update.kind === "reset") {
      reset(update.text);
    }
  }, [getSession, markdown, reset]);

  const handleError = useCallback((error: Error, phase: MarkdownErrorPhase) => {
    handleMarkdownStreamError(error, phase);
    queueMicrotask(() => {
      if (activeRef.current) setFailed(true);
    });
  }, []);

  if (failed) {
    return <MarkdownFallback markdown={markdown} />;
  }

  return (
    <MarkdownStream
      highlightCode
      incrementalParsing
      onError={handleError}
      onLinkPress={handleMarkdownLinkPress}
      options={MARKDOWN_OPTIONS}
      renderers={MARKDOWN_RENDERERS}
      session={session}
      styles={MARKDOWN_STYLES}
      theme={MARKDOWN_THEME}
      updateStrategy="raf"
    />
  );
});

const markdownStyles = StyleSheet.create({
  document: {
    width: "100%",
    minWidth: 0,
  },
  fallbackText: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 23,
  },
  codeCard: {
    width: "100%",
    overflow: "hidden",
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.elevated,
    marginVertical: 9,
  },
  codeHeader: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 13,
    paddingRight: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderStrong,
  },
  codeLanguage: {
    flex: 1,
    color: colors.tertiary,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  codeBody: {
    marginVertical: 0,
    padding: 13,
    borderWidth: 0,
    borderRadius: 0,
  },
  copyButton: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  responseCopyButton: {
    minHeight: 28,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 4,
    borderRadius: 7,
  },
  responseCopyLabel: {
    color: colors.tertiary,
    fontSize: 11,
    fontWeight: "600",
  },
  copiedLabel: {
    color: colors.success,
  },
  pressed: {
    opacity: 0.52,
  },
});
