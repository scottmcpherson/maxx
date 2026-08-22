import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  Keyboard,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type KeyboardEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import Svg, { Circle } from "react-native-svg";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnection } from "../connection/ConnectionProvider";
import { GlassButton, GlassPill } from "../components/GlassButton";
import { GlassSurface } from "../components/GlassSurface";
import {
  loadPinnedThreadIDs,
  loadShowProviderDiagnostics,
  loadUnseenThreadIDs,
  savePinnedThreadIDs,
  saveShowProviderDiagnostics,
  saveUnseenThreadIDs,
} from "../connection/secureStore";
import { colors, spacing } from "../theme";
import {
  CHATS_PROJECT_ID,
  projectName,
  type ActiveTurnRecord,
  type ChatAttachment,
  type ChatProject,
  type ChatThread,
  type RuntimeEventEnvelope,
  type TurnFinishedEnvelope,
} from "../types";
import { choosePhotoOrVideo, pasteClipboardImage, pickDocument, takePhoto, uploadAttachment } from "./attachments";
import { canPreviewAsNativeImage } from "./attachmentTypes";
import {
  activityPresentation,
  cleanAssistantText,
  latestTurn,
  mobileTimeline,
  shouldRenderLiveTurn,
  type MobileActivity,
} from "./runtime";
import {
  attentionThreads,
  unseenTargetForFinishedTurn,
  withStickyAttention,
  type AttentionReason,
  type StickyAttention,
} from "./sidebarAttention";
import { isNearScrollBottom } from "./scrollFollow";
import {
  firstNewUserMessageIndex,
  remainingTurnAnchorSpacer,
  turnAnchorSpacerHeight,
} from "./turnAnchor";
import { useVoiceDictation } from "./useVoiceDictation";
import {
  composerPrimaryAction,
  conversationIsAvailable,
  sttIsAvailable,
  type ComposerPrimaryAction,
} from "./composerVoice";
import { MobileTtsPlayer } from "./mobileTts";
import { chatCreationRequest } from "./chatCreation";
import { MobileRuntimePicker, type MobileRuntimeSelection } from "./MobileRuntimePicker";
import { AssistantMarkdown, StreamingAssistantMarkdown } from "./MarkdownMessage";

type Selection = { projectID: string; threadID: string };

const HEADER_FADE_HEIGHT = 34;
const SIDEBAR_FOOTER_FADE_HEIGHT = 132;
const COMPOSER_FOOTER_FADE_HEIGHT = 96;
const ATTACHMENT_MENU_ACTIONS: MenuAction[] = [
  { id: "photos", title: "Photos & Videos", image: "photo.on.rectangle" },
  { id: "camera", title: "Camera", image: "camera.fill" },
  { id: "file", title: "Files", image: "doc.fill" },
  { id: "paste", title: "Paste Image", image: "doc.on.clipboard" },
];

type AttachmentChoice = "file" | "camera" | "photos" | "paste";

function threadMenuActions(pinned: boolean): MenuAction[] {
  return [
    { id: "pin", title: pinned ? "Unpin chat" : "Pin chat", image: pinned ? "pin.slash" : "pin" },
    { id: "rename", title: "Rename chat", image: "pencil" },
    {
      title: "",
      displayInline: true,
      subactions: [{ id: "delete", title: "Delete chat", image: "trash", attributes: { destructive: true } }],
    },
  ];
}

function animateSidebarLayout() {
  LayoutAnimation.configureNext({
    duration: 190,
    create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    update: { type: LayoutAnimation.Types.easeInEaseOut },
    delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
  });
}

function SidebarMenuGlyph() {
  return (
    <View style={styles.sidebarMenuGlyph}>
      <View style={styles.sidebarMenuGlyphLong} />
      <View style={styles.sidebarMenuGlyphShort} />
    </View>
  );
}

export function ChatApp() {
  const { workspace, client, state, refreshWorkspace, reconnect, forget } = useConnection();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const drawer = useRef(new Animated.Value(0)).current;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pinned, setPinned] = useState<string[]>([]);
  const [unseen, setUnseen] = useState<string[]>([]);
  const [showProviderDiagnostics, setShowProviderDiagnostics] = useState(false);
  const [activeTurnByThread, setActiveTurnByThread] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const workspaceRef = useRef(workspace);
  const selectionRef = useRef(selection);

  const threads = useMemo(() => flattenThreads(workspace?.projects || []), [workspace]);
  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  useEffect(() => {
    void Promise.all([
      loadPinnedThreadIDs(),
      loadUnseenThreadIDs(),
      loadShowProviderDiagnostics(),
    ]).then(([savedPinned, savedUnseen, savedShowProviderDiagnostics]) => {
      setPinned(savedPinned);
      setUnseen(savedUnseen);
      setShowProviderDiagnostics(savedShowProviderDiagnostics);
    });
  }, []);
  useEffect(() => {
    if (selection && threads.some((item) => item.thread.id === selection.threadID)) return;
    const first = [...threads].sort((a, b) => b.thread.updatedAt - a.thread.updatedAt)[0];
    if (first) setSelection({ projectID: first.project.id, threadID: first.thread.id });
  }, [selection, threads]);

  const updateUnseen = useCallback((update: (current: string[]) => string[]) => {
    setUnseen((current) => {
      const next = update(current);
      if (next === current) return current;
      void saveUnseenThreadIDs(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!workspace) return;
    const liveThreadIDs = new Set(threads.map((item) => item.thread.id));
    updateUnseen((current) => {
      const next = current.filter((threadID) => liveThreadIDs.has(threadID));
      return next.length === current.length ? current : next;
    });
  }, [threads, updateUnseen, workspace]);

  useEffect(() => {
    if (!client) {
      setActiveTurnByThread({});
      return undefined;
    }
    let disposed = false;
    void client.request<ActiveTurnRecord[]>("active_turns").then((turns) => {
      if (disposed) return;
      const next: Record<string, string> = {};
      for (const turn of turns) next[turn.threadID] = turn.turnID;
      setActiveTurnByThread(next);
    }).catch(() => undefined);
    const unsubscribe = client.onEvent((hostEvent) => {
      if (hostEvent.event === "runtime://event") {
        const envelope = hostEvent.payload as RuntimeEventEnvelope;
        if (!envelope?.threadID || !envelope.event?.turnID) return;
        setActiveTurnByThread((current) => ({ ...current, [envelope.threadID]: envelope.event.turnID }));
      }
      if (hostEvent.event === "turn://finished") {
        const envelope = hostEvent.payload as TurnFinishedEnvelope;
        if (!envelope?.threadID || !envelope.turnID) return;
        setActiveTurnByThread((current) => {
          if (current[envelope.threadID] !== envelope.turnID) return current;
          const next = { ...current };
          delete next[envelope.threadID];
          return next;
        });
        const targetID = unseenTargetForFinishedTurn(
          workspaceRef.current,
          envelope,
          selectionRef.current?.threadID || null,
        );
        if (targetID) {
          updateUnseen((current) => current.includes(targetID) ? current : [...current, targetID]);
        }
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [client, updateUnseen]);

  const current = selection
    ? threads.find((item) => item.project.id === selection.projectID && item.thread.id === selection.threadID)
    : undefined;

  const setOpen = useCallback((open: boolean) => {
    drawer.stopAnimation();
    Keyboard.dismiss();
    if (open) {
      setDrawerOpen(true);
    }
    Animated.spring(drawer, { toValue: open ? 1 : 0, useNativeDriver: true, damping: 24, stiffness: 240, mass: 0.9 }).start(({ finished }) => {
      if (finished && !open) setDrawerOpen(false);
    });
  }, [drawer]);

  const select = (projectID: string, threadID: string) => {
    updateUnseen((current) => {
      const next = current.filter((id) => id !== threadID);
      return next.length === current.length ? current : next;
    });
    setSelection({ projectID, threadID });
    setOpen(false);
  };

  const createChat = async (projectID = CHATS_PROJECT_ID) => {
    if (!client || !workspace) return;
    try {
      const recent = [...threads].sort((a, b) => b.thread.updatedAt - a.thread.updatedAt)[0]?.thread;
      const profile = workspace.providerProfiles.find((item) => item.isEnabled) || workspace.providerProfiles[0];
      if (!profile && !recent) throw new Error("Configure an AI provider in Maxx desktop first.");
      const provider = recent?.provider || profile.provider;
      let model = recent?.model;
      if (!model) {
        const catalog = await client.request<{ models: Array<{ model: string; isDefault?: boolean }> }>("list_provider_models", {
          provider,
          profileId: profile.id,
          workingDirectory: workspace.projects.find((item) => item.id === projectID)?.folderPath || null,
        });
        model = catalog.models.find((item) => item.isDefault)?.model || catalog.models[0]?.model;
      }
      if (!model) throw new Error("No model is available for the selected provider.");
      const common = {
        provider,
        model,
        title: "New chat",
        effort: recent?.effort || null,
        speed: recent?.speed || null,
      };
      const request = chatCreationRequest(projectID, common);
      const thread = await client.request<ChatThread>(request.method, request.params);
      await refreshWorkspace();
      select(projectID, thread.id);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (cause) {
      Alert.alert("Couldn’t create chat", message(cause));
    }
  };

  const togglePinned = async (threadID: string) => {
    const next = pinned.includes(threadID) ? pinned.filter((id) => id !== threadID) : [...pinned, threadID];
    animateSidebarLayout();
    setPinned(next);
    await savePinnedThreadIDs(next);
  };

  const renameChat = (projectID: string, thread: ChatThread) => {
    if (!client) return;
    Alert.prompt(
      "Rename chat",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Rename",
          onPress: (value?: string) => {
            const title = value?.trim();
            if (!title) return;
            void client.request("update_thread", { projectId: projectID, threadId: thread.id, title })
              .then(refreshWorkspace)
              .catch((cause) => Alert.alert("Couldn’t rename chat", message(cause)));
          },
        },
      ],
      "plain-text",
      thread.title,
    );
  };

  const deleteChat = async (projectID: string, threadID: string) => {
    if (!client) return;
    try {
      await client.request("remove_thread", { projectId: projectID, threadId: threadID });
      const nextPinned = pinned.filter((id) => id !== threadID);
      if (nextPinned.length !== pinned.length) {
        setPinned(nextPinned);
        await savePinnedThreadIDs(nextPinned);
      }
      updateUnseen((current) => {
        const next = current.filter((id) => id !== threadID);
        return next.length === current.length ? current : next;
      });
      await refreshWorkspace();
    } catch (cause) {
      Alert.alert("Couldn’t delete chat", message(cause));
    }
  };

  const drawerTranslate = drawer.interpolate({ inputRange: [0, 1], outputRange: [-width, 0] });
  const chatHeaderHeight = insets.top + 66 + (state.status === "disconnected" ? 34 : 0) + HEADER_FADE_HEIGHT;

  return (
    <View style={styles.root}>
      <View style={styles.main}>
        <View style={styles.chatScene}>
          {current && client ? (
            <Conversation
              key={current.thread.id}
              project={current.project}
              thread={current.thread}
              headerHeight={chatHeaderHeight}
              showProviderDiagnostics={showProviderDiagnostics}
            />
          ) : (
            <EmptyChat onNew={() => void createChat()} />
          )}
          <View style={[styles.chatHeader, { paddingTop: insets.top }]}>
            <HeaderFade backgroundColor={colors.background} rgb="8,10,14" />
            <View style={styles.topbar}>
              <GlassButton label="Open sidebar" symbol="line.3.horizontal" onPress={() => setOpen(true)}>
                <SidebarMenuGlyph />
              </GlassButton>
              <View style={styles.titleBlock}>
                <Text numberOfLines={1} style={styles.chatTitle}>{current?.thread.title || "Maxx"}</Text>
                <Text numberOfLines={1} style={styles.chatSubtitle}>
                  {current ? `${current.thread.provider} · ${current.thread.model}` : "Choose or create a chat"}
                </Text>
              </View>
              {current ? (
                <ChatHeaderActions
                  project={current.project}
                  thread={current.thread}
                  pinned={pinned.includes(current.thread.id)}
                  onPin={() => void togglePinned(current.thread.id)}
                  onRename={() => renameChat(current.project.id, current.thread)}
                  onDelete={() => void deleteChat(current.project.id, current.thread.id)}
                  onNew={() => void createChat(current.project.id)}
                />
              ) : <View style={styles.headerActionsSpacer} />}
            </View>
            {state.status === "disconnected" ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Reconnect to Mac" style={styles.offlineBanner} onPress={() => void reconnect()}>
                <SymbolView name="wifi.slash" size={15} tintColor={colors.text} />
                <Text style={styles.offlineText}>Connection lost — tap to reconnect</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>

      <Animated.View
        accessibilityViewIsModal={drawerOpen}
        pointerEvents={drawerOpen ? "auto" : "none"}
        style={[styles.drawer, { transform: [{ translateX: drawerTranslate }] }]}
      >
        <Sidebar
          projects={workspace?.projects || []}
          selectedThreadID={selection?.threadID || null}
          pinned={pinned}
          unseen={unseen}
          activeTurnByThread={activeTurnByThread}
          onClose={() => setOpen(false)}
          onSelect={select}
          onPin={(id) => void togglePinned(id)}
          onRename={renameChat}
          onDelete={(projectID, threadID) => void deleteChat(projectID, threadID)}
          onNew={() => void createChat()}
          onNewInProject={(projectID) => void createChat(projectID)}
          onSettings={() => setSettingsOpen(true)}
        />
      </Animated.View>
      <SettingsModal
        visible={settingsOpen}
        hostName={state.status === "connected" ? state.profile.hostName : "Maxx"}
        address={state.status === "connected" ? state.profile.address : ""}
        showProviderDiagnostics={showProviderDiagnostics}
        onShowProviderDiagnosticsChange={(visible) => {
          setShowProviderDiagnostics(visible);
          void saveShowProviderDiagnostics(visible);
        }}
        onClose={() => setSettingsOpen(false)}
        onReconnect={() => void reconnect()}
        onForget={() => {
          Alert.alert("Forget this Mac?", "You’ll need to scan a new pairing code to reconnect.", [
            { text: "Cancel", style: "cancel" },
            { text: "Forget", style: "destructive", onPress: () => { setSettingsOpen(false); void forget(); } },
          ]);
        }}
      />
    </View>
  );
}

function ChatHeaderActions({ project, thread, pinned, onPin, onRename, onDelete, onNew }: {
  project: ChatProject;
  thread: ChatThread;
  pinned: boolean;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
  onNew: () => void;
}) {
  return (
    <GlassSurface
      isInteractive
      tintColor="rgba(20,25,34,0.44)"
      style={styles.headerActions}
      fallbackStyle={styles.headerActionFallback}
    >
      <MenuView
        style={styles.headerActionMenu}
        actions={threadMenuActions(pinned)}
        onPressAction={(event) => {
          if (event.nativeEvent.event === "pin") onPin();
          if (event.nativeEvent.event === "rename") onRename();
          if (event.nativeEvent.event === "delete") onDelete();
        }}
      >
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel={`More actions for ${thread.title}`}
          style={styles.headerActionContent}
        >
          <SymbolView name="ellipsis" size={20} weight="semibold" tintColor={colors.text} />
        </View>
      </MenuView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`New chat in ${projectName(project)}`}
        onPress={onNew}
        style={({ pressed }) => [styles.headerActionContent, pressed && styles.headerActionPressed]}
      >
        <SymbolView name="square.and.pencil" size={20} weight="semibold" tintColor={colors.text} />
      </Pressable>
    </GlassSurface>
  );
}

function Conversation({ project, thread, headerHeight, showProviderDiagnostics }: {
  project: ChatProject;
  thread: ChatThread;
  headerHeight: number;
  showProviderDiagnostics: boolean;
}) {
  const { client, workspace, refreshWorkspace } = useConnection();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [runtimeUpdating, setRuntimeUpdating] = useState(false);
  const [composerHeight, setComposerHeight] = useState(insets.bottom + 66);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [anchoredMessageID, setAnchoredMessageID] = useState<string | null>(null);
  const [anchorSpacerHeight, setAnchorSpacerHeight] = useState(0);
  const listRef = useRef<FlatList>(null);
  const initialScrollPendingRef = useRef(true);
  const pendingAnchorBaselineRef = useRef<Set<string> | null>(null);
  const pendingAnchorIndexRef = useRef<number | null>(null);
  const activeAnchorRef = useRef<{
    messageID: string;
    index: number;
    initialSpacerHeight: number;
    currentSpacerHeight: number;
    baseContentHeight: number | null;
  } | null>(null);
  const followBottomRef = useRef(true);
  const scrollInteractionRef = useRef(false);
  const programmaticScrollRef = useRef<"bottom" | "anchor" | null>(null);
  const animatedScrollRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const composerInputRef = useRef<TextInput>(null);
  const composerTranslate = useRef(new Animated.Value(0)).current;
  const dictatedBaseRef = useRef("");
  const conversationGenerationRef = useRef(0);
  const conversationPhaseRef = useRef<"idle" | "listening" | "waiting" | "speaking">("idle");
  const conversationFinalRef = useRef<(text: string) => void>(() => undefined);
  const assistantBaselineRef = useRef<Set<string>>(new Set());
  const ttsPlayerRef = useRef<MobileTtsPlayer | null>(null);
  const [conversationPhase, setConversationPhaseState] = useState<"idle" | "listening" | "waiting" | "speaking">("idle");
  const voiceSettings = workspace?.voice;
  const dictationAvailable = sttIsAvailable(voiceSettings);
  const conversationAvailable = conversationIsAvailable(voiceSettings);
  const messages = useMemo(() => thread.messages.filter((item) => item.role !== "system"), [thread.messages]);
  const timelineItems = useMemo(
    () => mobileTimeline(messages, thread.runtimeEvents, showProviderDiagnostics),
    [messages, showProviderDiagnostics, thread.runtimeEvents],
  );
  const liveTurn = latestTurn(thread.runtimeEvents);
  const waitingForSubmittedMessage = pendingAnchorBaselineRef.current !== null;
  const showLiveTurn = shouldRenderLiveTurn(
    messages,
    liveTurn,
    sending,
    waitingForSubmittedMessage,
  );
  const voice = useVoiceDictation(client, (text, final) => {
    if (conversationPhaseRef.current !== "idle") {
      if (final) conversationFinalRef.current(text);
      return;
    }
    const spacer = dictatedBaseRef.current.trim() ? " " : "";
    setDraft(`${dictatedBaseRef.current}${spacer}${text}`);
    if (final) dictatedBaseRef.current = `${dictatedBaseRef.current}${spacer}${text}`;
  });

  const setConversationPhase = useCallback((phase: "idle" | "listening" | "waiting" | "speaking") => {
    conversationPhaseRef.current = phase;
    setConversationPhaseState(phase);
  }, []);

  useEffect(() => () => {
    const pending = attachmentsRef.current;
    attachmentsRef.current = [];
    for (const attachment of pending) {
      void client?.request("discard_media", { attachmentId: attachment.id }).catch(() => undefined);
    }
  }, [client]);

  const scheduleScrollToBottom = useCallback((animated: boolean) => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    programmaticScrollRef.current = "bottom";
    animatedScrollRef.current = animated;
    scrollInteractionRef.current = false;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      listRef.current?.scrollToEnd({ animated });
    });
  }, []);

  const scrollToBottom = useCallback((animated: boolean) => {
    followBottomRef.current = true;
    setShowScrollToBottom(false);
    scheduleScrollToBottom(animated);
  }, [scheduleScrollToBottom]);

  const scrollToMessageTop = useCallback((index: number, animated: boolean) => {
    programmaticScrollRef.current = "anchor";
    animatedScrollRef.current = animated;
    scrollInteractionRef.current = false;
    listRef.current?.scrollToIndex({
      index,
      animated,
      viewPosition: 0,
      viewOffset: headerHeight + 16,
    });
  }, [headerHeight]);

  const clearTurnAnchor = useCallback(() => {
    pendingAnchorBaselineRef.current = null;
    pendingAnchorIndexRef.current = null;
    activeAnchorRef.current = null;
    setAnchoredMessageID(null);
    setAnchorSpacerHeight(0);
  }, []);

  const prepareTurnAnchor = useCallback(() => {
    pendingAnchorBaselineRef.current = new Set(messages.map((item) => item.id));
    pendingAnchorIndexRef.current = null;
    activeAnchorRef.current = null;
    setAnchoredMessageID(null);
    setAnchorSpacerHeight(0);
    followBottomRef.current = false;
    scrollInteractionRef.current = false;
    setShowScrollToBottom(false);
  }, [messages]);

  const updateScrollFollowState = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const atBottom = isNearScrollBottom({
      contentHeight: event.nativeEvent.contentSize.height,
      offsetY: event.nativeEvent.contentOffset.y,
      viewportHeight: event.nativeEvent.layoutMeasurement.height,
      reservedBottomHeight: activeAnchorRef.current?.currentSpacerHeight ?? 0,
    });
    followBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

  useEffect(() => {
    setDraft("");
    setAttachments([]);
    clearTurnAnchor();
    followBottomRef.current = true;
    setShowScrollToBottom(false);
  }, [clearTurnAnchor, thread.id]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useEffect(() => {
    const moveWithKeyboard = (event: KeyboardEvent) => {
      const keyboardHeight = Math.max(0, windowHeight - event.endCoordinates.screenY);
      const offset = Math.max(0, keyboardHeight - insets.bottom);
      setKeyboardOffset(offset);
      Animated.timing(composerTranslate, {
        toValue: -offset,
        duration: event.duration || 250,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    };
    const reset = (event?: KeyboardEvent) => {
      setKeyboardOffset(0);
      Animated.timing(composerTranslate, {
        toValue: 0,
        duration: event?.duration || 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    };
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow", moveWithKeyboard);
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", reset);
    return () => {
      show.remove();
      hide.remove();
    };
  }, [composerTranslate, insets.bottom, windowHeight]);

  useEffect(() => {
    if (keyboardOffset > 0) {
      if (!anchoredMessageID && !pendingAnchorBaselineRef.current && followBottomRef.current) {
        scrollToBottom(true);
      }
    }
  }, [anchoredMessageID, keyboardOffset, scrollToBottom]);

  useEffect(() => {
    const baseline = pendingAnchorBaselineRef.current;
    if (!baseline) return;
    const messageIndex = firstNewUserMessageIndex(messages, baseline);
    if (messageIndex < 0) return;
    const messageID = messages[messageIndex].id;
    const index = timelineItems.findIndex((item) => item.type === "message" && item.message.id === messageID);
    if (index < 0) return;
    const spacerHeight = turnAnchorSpacerHeight(
      windowHeight,
      headerHeight,
      composerHeight,
      keyboardOffset,
    );
    pendingAnchorBaselineRef.current = null;
    pendingAnchorIndexRef.current = index;
    activeAnchorRef.current = {
      messageID,
      index,
      initialSpacerHeight: spacerHeight,
      currentSpacerHeight: spacerHeight,
      baseContentHeight: null,
    };
    setAnchoredMessageID(messageID);
    setAnchorSpacerHeight(spacerHeight);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (activeAnchorRef.current?.messageID !== messageID) return;
        pendingAnchorIndexRef.current = null;
        scrollToMessageTop(index, true);
      });
    });
  }, [composerHeight, headerHeight, keyboardOffset, messages, scrollToMessageTop, timelineItems, windowHeight]);

  const addAttachment = async (kind: AttachmentChoice) => {
    if (!client) return;
    setUploading(true);
    try {
      const item = kind === "file"
        ? await pickDocument()
        : kind === "camera"
          ? await takePhoto()
          : kind === "photos"
            ? await choosePhotoOrVideo()
            : await pasteClipboardImage();
      const uploaded = await uploadAttachment(client, item);
      if (uploaded) {
        setAttachments((items) => {
          const next = [...items, uploaded];
          attachmentsRef.current = next;
          return next;
        });
      }
    } catch (cause) {
      Alert.alert("Couldn’t attach item", message(cause));
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = useCallback((attachment: ChatAttachment) => {
    setAttachments((items) => {
      const next = items.filter((candidate) => candidate.id !== attachment.id);
      attachmentsRef.current = next;
      return next;
    });
    void client?.request("discard_media", { attachmentId: attachment.id }).catch(() => undefined);
  }, [client]);

  const send = async () => {
    if (!client || sending || (!draft.trim() && !attachments.length)) return;
    const prompt = draft.trim();
    const ids = attachmentsRef.current.map((item) => item.id);
    if (voice.recording) await voice.stop().catch(() => undefined);
    prepareTurnAnchor();
    composerInputRef.current?.blur();
    Keyboard.dismiss();
    dictatedBaseRef.current = "";
    setDraft("");
    setSending(true);
    try {
      await client.request("send_prompt", {
        projectId: project.id,
        threadId: thread.id,
        prompt,
        attachmentPaths: [],
        attachmentIds: ids,
        annotations: [],
        textSelections: [],
      });
      attachmentsRef.current = [];
      setAttachments([]);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (cause) {
      clearTurnAnchor();
      scrollToBottom(false);
      setDraft(prompt);
      Alert.alert("Message not sent", message(cause));
    } finally {
      setSending(false);
    }
  };

  const endConversation = useCallback(async () => {
    conversationGenerationRef.current += 1;
    assistantBaselineRef.current.clear();
    setConversationPhase("idle");
    await Promise.all([
      voice.cancel().catch(() => undefined),
      ttsPlayerRef.current?.cancel().catch(() => undefined) ?? Promise.resolve(),
    ]);
  }, [setConversationPhase, voice.cancel]);

  const startConversationListening = useCallback(async () => {
    if (!client || !voiceSettings || !conversationAvailable) return;
    setConversationPhase("listening");
    await voice.start({ stopOnSilence: true });
  }, [client, conversationAvailable, setConversationPhase, voice.start, voiceSettings]);

  const submitConversationTranscript = useCallback(async (spokenText: string) => {
    const prompt = spokenText.trim();
    const generation = conversationGenerationRef.current;
    if (!client || !prompt || conversationPhaseRef.current === "idle") {
      await endConversation();
      return;
    }
    prepareTurnAnchor();
    assistantBaselineRef.current = new Set(
      messages.filter((item) => item.role === "assistant").map((item) => item.id),
    );
    setConversationPhase("waiting");
    try {
      await client.request("send_prompt", {
        projectId: project.id,
        threadId: thread.id,
        prompt,
        attachmentPaths: [],
        attachmentIds: [],
        annotations: [],
        textSelections: [],
      });
      if (generation === conversationGenerationRef.current) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch (cause) {
      if (generation !== conversationGenerationRef.current) return;
      clearTurnAnchor();
      scrollToBottom(false);
      Alert.alert("Voice message not sent", message(cause));
      await endConversation();
    }
  }, [clearTurnAnchor, client, endConversation, messages, prepareTurnAnchor, project.id, scrollToBottom, setConversationPhase, thread.id]);

  conversationFinalRef.current = (text) => { void submitConversationTranscript(text); };

  const startConversation = useCallback(async () => {
    if (!conversationAvailable) return;
    composerInputRef.current?.blur();
    Keyboard.dismiss();
    conversationGenerationRef.current += 1;
    assistantBaselineRef.current = new Set(
      messages.filter((item) => item.role === "assistant").map((item) => item.id),
    );
    try {
      await ttsPlayerRef.current?.cancel();
      await startConversationListening();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (cause) {
      Alert.alert("Voice conversation unavailable", message(cause));
      await endConversation();
    }
  }, [conversationAvailable, endConversation, messages, startConversationListening]);

  useEffect(() => {
    if (
      conversationPhase !== "waiting"
      || liveTurn.active
      || !client
      || !voiceSettings
    ) return;
    if (liveTurn.error) {
      Alert.alert("Voice conversation stopped", liveTurn.error);
      void endConversation();
      return;
    }
    const response = [...messages].reverse().find((item) => (
      item.role === "assistant" && !assistantBaselineRef.current.has(item.id)
    ));
    if (!response) return;
    const spokenResponse = cleanAssistantText(response.content).trim();
    const generation = conversationGenerationRef.current;
    if (!spokenResponse) {
      void startConversationListening().catch(async (cause) => {
        if (generation !== conversationGenerationRef.current) return;
        Alert.alert("Voice conversation stopped", message(cause));
        await endConversation();
      });
      return;
    }
    const player = ttsPlayerRef.current ?? new MobileTtsPlayer();
    ttsPlayerRef.current = player;
    setConversationPhase("speaking");
    void player.play(client, voiceSettings, spokenResponse)
      .then(async () => {
        if (generation !== conversationGenerationRef.current) return;
        await startConversationListening();
      })
      .catch(async (cause) => {
        if (generation !== conversationGenerationRef.current) return;
        Alert.alert("Voice conversation stopped", message(cause));
        await endConversation();
      });
  }, [client, conversationPhase, endConversation, liveTurn.active, liveTurn.error, messages, setConversationPhase, startConversationListening, voiceSettings]);

  useEffect(() => () => {
    conversationGenerationRef.current += 1;
    void ttsPlayerRef.current?.cancel();
  }, []);

  const toggleDictation = async () => {
    try {
      if (voice.recording) await voice.stop();
      else {
        dictatedBaseRef.current = draft.trimEnd();
        await voice.start();
      }
    } catch (cause) {
      Alert.alert("Voice input unavailable", message(cause));
    }
  };

  const hasComposerContent = draft.trim().length > 0 || attachments.length > 0;
  const conversationActive = conversationPhase !== "idle";
  const primaryAction = composerPrimaryAction({
    conversationActive,
    hasContent: hasComposerContent,
    conversationAvailable,
  });
  const primaryDisabled = sending || (primaryAction === "send" && !hasComposerContent);

  const performPrimaryAction = () => {
    if (primaryAction === "conversation") {
      void startConversation();
    } else if (primaryAction === "stop-conversation") {
      void endConversation();
    } else {
      void send();
    }
  };

  const updateRuntime = async (next: MobileRuntimeSelection) => {
    if (!client || runtimeUpdating) return;
    setRuntimeUpdating(true);
    try {
      await client.request("update_thread", {
        projectId: project.id,
        threadId: thread.id,
        provider: next.provider,
        model: next.model,
        effort: next.effort || "",
        speed: next.speed || "",
        updateRuntimeKnobs: true,
      });
      await refreshWorkspace();
      void Haptics.selectionAsync();
    } catch (cause) {
      Alert.alert("Couldn’t change harness or model", message(cause));
    } finally {
      setRuntimeUpdating(false);
    }
  };

  return (
    <View style={styles.conversation}>
      <FlatList
        ref={listRef}
        data={timelineItems}
        keyExtractor={(item) => item.id}
        style={styles.transcriptList}
        contentContainerStyle={[
          timelineItems.length ? styles.transcript : styles.emptyTranscript,
          { paddingTop: headerHeight + 16 },
        ]}
        contentInsetAdjustmentBehavior="never"
        scrollIndicatorInsets={{ top: headerHeight, bottom: composerHeight + keyboardOffset }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={(_, contentHeight) => {
          const anchor = activeAnchorRef.current;
          if (anchor) {
            const contentWithoutSpacer = contentHeight - anchor.currentSpacerHeight;
            if (anchor.baseContentHeight === null) {
              anchor.baseContentHeight = contentWithoutSpacer;
            } else {
              const nextSpacerHeight = remainingTurnAnchorSpacer(
                anchor.initialSpacerHeight,
                anchor.baseContentHeight,
                contentWithoutSpacer,
              );
              if (nextSpacerHeight !== anchor.currentSpacerHeight) {
                anchor.currentSpacerHeight = nextSpacerHeight;
                setAnchorSpacerHeight(nextSpacerHeight);
              }
              if (nextSpacerHeight === 0) {
                activeAnchorRef.current = null;
                setAnchoredMessageID(null);
                followBottomRef.current = true;
                setShowScrollToBottom(false);
                scheduleScrollToBottom(false);
              }
            }
            const pendingIndex = pendingAnchorIndexRef.current;
            if (pendingIndex !== null) {
              pendingAnchorIndexRef.current = null;
              scrollToMessageTop(pendingIndex, true);
            }
            return;
          }
          if (pendingAnchorBaselineRef.current) return;
          if (initialScrollPendingRef.current) {
            initialScrollPendingRef.current = false;
            scrollToBottom(false);
            return;
          }
          if (followBottomRef.current) scheduleScrollToBottom(false);
        }}
        onScroll={(event) => {
          if (scrollInteractionRef.current) updateScrollFollowState(event);
        }}
        onScrollBeginDrag={() => {
          clearTurnAnchor();
          programmaticScrollRef.current = null;
          animatedScrollRef.current = false;
          scrollInteractionRef.current = true;
        }}
        onScrollEndDrag={(event) => {
          updateScrollFollowState(event);
        }}
        onMomentumScrollEnd={(event) => {
          const programmaticScroll = programmaticScrollRef.current;
          if (programmaticScroll !== null) {
            const needsFinalSettle = animatedScrollRef.current;
            programmaticScrollRef.current = null;
            animatedScrollRef.current = false;
            scrollInteractionRef.current = false;
            setShowScrollToBottom(false);
            if (programmaticScroll === "bottom") {
              followBottomRef.current = true;
              if (needsFinalSettle) scheduleScrollToBottom(false);
            } else {
              followBottomRef.current = false;
            }
            return;
          }
          if (scrollInteractionRef.current) updateScrollFollowState(event);
          scrollInteractionRef.current = false;
        }}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          listRef.current?.scrollToOffset({
            offset: Math.max(0, averageItemLength * index - headerHeight),
            animated: false,
          });
          requestAnimationFrame(() => scrollToMessageTop(index, true));
        }}
        scrollEventThrottle={16}
        renderItem={({ item }) => item.type === "message"
          ? <MessageBubble message={item.message} />
          : <ActivityDisclosure activity={item.activity} />}
        ListEmptyComponent={<EmptyTranscript />}
        ListFooterComponent={(
          <View style={styles.transcriptFooter}>
            {showLiveTurn
              ? <LiveBubble text={liveTurn.error || liveTurn.text || "Working…"} error={!!liveTurn.error} />
              : null}
            <View style={{ height: composerHeight + keyboardOffset + 14 }} />
            {anchorSpacerHeight > 0 ? <View style={{ height: anchorSpacerHeight }} /> : null}
          </View>
        )}
      />

      <Animated.View
        pointerEvents="none"
        style={[
          styles.composerFooterFade,
          {
            height: composerHeight + COMPOSER_FOOTER_FADE_HEIGHT,
            transform: [{ translateY: composerTranslate }],
          },
        ]}
      >
        <FooterFade backgroundColor={colors.background} rgb="5,6,9" />
      </Animated.View>

      {showScrollToBottom && !anchoredMessageID ? (
        <View style={[styles.scrollToBottom, { bottom: composerHeight + keyboardOffset + 12 }]}>
          <GlassButton
            label="Scroll to bottom"
            symbol="arrow.down"
            size={42}
            onPress={() => scrollToBottom(true)}
          />
        </View>
      ) : null}

      <Animated.View
        style={[
          styles.composerOverlay,
          {
            paddingBottom: insets.bottom + 8,
            transform: [{ translateY: composerTranslate }],
          },
        ]}
        onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
      >
        {attachments.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attachmentTray}>
            {attachments.map((item) => (
              <View key={item.id} style={styles.attachmentChip}>
                <SymbolView name={item.mimeType.startsWith("image/") ? "photo" : "doc.fill"} size={15} tintColor={colors.accent} />
                <Text numberOfLines={1} style={styles.attachmentName}>{item.displayName}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${item.displayName}`}
                  accessibilityState={{ disabled: sending }}
                  disabled={sending}
                  onPress={() => removeAttachment(item)}
                >
                  <SymbolView name="xmark.circle.fill" size={17} tintColor={colors.tertiary} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}

        {conversationActive ? <Text style={styles.voiceStatus}>{conversationStatus(conversationPhase)}</Text> : null}
        {voice.error ? <Text style={styles.voiceError}>{voice.error}</Text> : null}
        <View style={styles.composerRow}>
          <GlassSurface
            isInteractive
            tintColor={voice.recording || conversationActive ? "rgba(50,77,124,0.42)" : "rgba(20,25,34,0.44)"}
            style={styles.composer}
            fallbackStyle={[styles.composerFallback, (voice.recording || conversationActive) && styles.composerRecording]}
          >
            <TextInput
              ref={composerInputRef}
              accessibilityLabel="Message"
              multiline
              editable={!conversationActive}
              placeholder={conversationActive ? conversationStatus(conversationPhase) : voice.recording ? "Listening…" : "Message Maxx"}
              placeholderTextColor={colors.tertiary}
              style={styles.composerInput}
              value={draft}
              onChangeText={setDraft}
              maxLength={40_000}
            />
            <View style={styles.composerControls}>
              <AttachmentMenuButton
                disabled={uploading || sending || conversationActive}
                uploading={uploading}
                onChoose={(kind) => void addAttachment(kind)}
              />
              {client ? (
                <MobileRuntimePicker
                  client={client}
                  provider={thread.provider}
                  model={thread.model}
                  effort={thread.effort || null}
                  speed={thread.speed || null}
                  profiles={workspace?.providerProfiles || []}
                  workingDirectory={project.folderPath}
                  disabled={sending || liveTurn.active || conversationActive || runtimeUpdating}
                  onChange={(next) => void updateRuntime(next)}
                />
              ) : <View style={styles.composerControlSpacer} />}
              <View style={styles.composerTrailingControls}>
                {dictationAvailable ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={voice.recording ? "Stop dictation" : "Start dictation"}
                    disabled={conversationActive || sending}
                    style={[styles.inlineButton, (conversationActive || sending) && styles.sendDisabled]}
                    onPress={() => void toggleDictation()}
                  >
                    <SymbolView name={voice.recording ? "stop.fill" : "mic.fill"} size={20} tintColor={voice.recording ? colors.danger : colors.secondary} />
                  </Pressable>
                ) : null}
                <ComposerPrimaryButton action={primaryAction} disabled={primaryDisabled} onPress={performPrimaryAction} />
              </View>
            </View>
          </GlassSurface>
        </View>
      </Animated.View>

    </View>
  );
}

function AttachmentMenuButton({ disabled, uploading, onChoose }: {
  disabled: boolean;
  uploading: boolean;
  onChoose: (kind: AttachmentChoice) => void;
}) {
  const trigger = (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel="Add attachment"
      accessibilityState={{ disabled }}
      style={[styles.inlineButton, disabled && styles.sendDisabled]}
    >
      <SymbolView name={uploading ? "hourglass" : "plus"} size={21} weight="semibold" tintColor={colors.secondary} />
    </View>
  );
  if (disabled) return trigger;
  return (
    <MenuView
      style={styles.attachmentMenu}
      actions={ATTACHMENT_MENU_ACTIONS}
      onPressAction={(event) => {
        const kind = event.nativeEvent.event;
        if (kind === "file" || kind === "camera" || kind === "photos" || kind === "paste") onChoose(kind);
      }}
    >
      {trigger}
    </MenuView>
  );
}

function ComposerPrimaryButton({ action, disabled, onPress }: {
  action: ComposerPrimaryAction;
  disabled: boolean;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const iconOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    iconOpacity.setValue(0.35);
    scale.setValue(0.84);
    Animated.parallel([
      Animated.spring(scale, {
        toValue: 1,
        damping: 13,
        stiffness: 320,
        mass: 0.55,
        useNativeDriver: true,
      }),
      Animated.timing(iconOpacity, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [action, iconOpacity, scale]);

  const animatePressed = (pressed: boolean) => {
    Animated.spring(scale, {
      toValue: pressed ? 1.1 : 1,
      damping: 15,
      stiffness: 360,
      mass: 0.5,
      useNativeDriver: true,
    }).start();
  };
  const symbol = action === "conversation" ? "waveform" : action === "stop-conversation" ? "stop.fill" : "arrow.up";
  const label = action === "conversation" ? "Start voice conversation" : action === "stop-conversation" ? "Stop voice conversation" : "Send message";

  return (
    <Animated.View style={{ opacity: disabled ? 0.35 : 1, transform: [{ scale }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        style={[styles.sendButton, action === "stop-conversation" && styles.stopConversationButton]}
        onPressIn={() => animatePressed(true)}
        onPressOut={() => animatePressed(false)}
        onPress={onPress}
      >
        <Animated.View style={{ opacity: iconOpacity }}>
          <SymbolView name={symbol} size={action === "conversation" ? 21 : 20} weight="bold" tintColor="white" />
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

function conversationStatus(phase: "idle" | "listening" | "waiting" | "speaking") {
  if (phase === "listening") return "Listening…";
  if (phase === "waiting") return "Thinking…";
  if (phase === "speaking") return "Speaking…";
  return "Message Maxx";
}

function Sidebar(props: {
  projects: ChatProject[];
  selectedThreadID: string | null;
  pinned: string[];
  unseen: string[];
  activeTurnByThread: Record<string, string>;
  onClose: () => void;
  onSelect: (projectID: string, threadID: string) => void;
  onPin: (threadID: string) => void;
  onRename: (projectID: string, thread: ChatThread) => void;
  onDelete: (projectID: string, threadID: string) => void;
  onNew: () => void;
  onNewInProject: (projectID: string) => void;
  onSettings: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const sidebarScrollRef = useRef<ScrollView>(null);
  const sidebarTransition = useRef(new Animated.Value(1)).current;
  const attentionTransitioningRef = useRef(false);
  const searchInputRef = useRef<TextInput>(null);
  const footerTranslate = useRef(new Animated.Value(0)).current;
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [collapsedProjectIDs, setCollapsedProjectIDs] = useState(() => new Set<string>());
  const [pinnedSectionExpanded, setPinnedSectionExpanded] = useState(true);
  const [projectsSectionExpanded, setProjectsSectionExpanded] = useState(true);
  const [chatsSectionExpanded, setChatsSectionExpanded] = useState(true);
  const [attentionFilterOpen, setAttentionFilterOpen] = useState(false);
  const [stickyAttention, setStickyAttention] = useState<StickyAttention | null>(null);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;
  const visibleProjects = searching
    ? props.projects
      .map((project) => ({
        ...project,
        threads: project.threads.filter((thread) => (
          `${thread.title} ${projectName(project)} ${thread.messages.map((item) => item.content).join(" ")}`
            .toLowerCase()
            .includes(normalizedQuery)
        )),
      }))
      .filter((project) => project.threads.length > 0)
    : props.projects;
  const attentionItems = useMemo(
    () => attentionThreads(
      props.projects,
      props.activeTurnByThread,
      new Set(props.unseen),
      props.selectedThreadID,
    ),
    [props.activeTurnByThread, props.projects, props.selectedThreadID, props.unseen],
  );
  const attentionDisplay = useMemo(
    () => withStickyAttention(attentionItems, props.projects, stickyAttention, props.selectedThreadID),
    [attentionItems, props.projects, props.selectedThreadID, stickyAttention],
  );
  const attentionThreadIDs = useMemo(
    () => new Set(attentionDisplay.map((item) => item.thread.id)),
    [attentionDisplay],
  );
  const attentionReasons = useMemo(
    () => new Map(attentionItems.map((item) => [item.thread.id, item.reason] as const)),
    [attentionItems],
  );
  const attentionProjects = useMemo(
    () => props.projects
      .map((project) => ({
        ...project,
        threads: project.threads.filter((thread) => attentionThreadIDs.has(thread.id)),
      }))
      .filter((project) => project.threads.length > 0),
    [attentionThreadIDs, props.projects],
  );
  const pinnedItems = attentionFilterOpen
    ? []
    : flattenThreads(visibleProjects).filter(({ thread }) => props.pinned.includes(thread.id));
  const unpinnedProjects = visibleProjects
    .map((project) => ({
      ...project,
      threads: project.threads.filter((thread) => !props.pinned.includes(thread.id)),
    }))
    .filter((project) => project.threads.length > 0);
  const displayedProjectFolders = (attentionFilterOpen ? attentionProjects : unpinnedProjects)
    .filter((project) => project.id !== CHATS_PROJECT_ID);
  const displayedChatProject = (attentionFilterOpen ? attentionProjects : unpinnedProjects)
    .find((project) => project.id === CHATS_PROJECT_ID);
  const sectionsForcedOpen = attentionFilterOpen || searching;
  const pinnedExpanded = sectionsForcedOpen || pinnedSectionExpanded;
  const projectsExpanded = sectionsForcedOpen || projectsSectionExpanded;
  const chatsExpanded = sectionsForcedOpen || chatsSectionExpanded;
  const searchActive = searchFocused || searching;
  const noSearchResults = searching && visibleProjects.length === 0;

  useEffect(() => {
    if (
      stickyAttention
      && (!attentionFilterOpen || stickyAttention.threadID !== props.selectedThreadID)
    ) {
      setStickyAttention(null);
    }
  }, [attentionFilterOpen, props.selectedThreadID, stickyAttention]);

  useEffect(() => {
    if (!searchFocused) {
      Animated.timing(footerTranslate, { toValue: 0, duration: 180, useNativeDriver: true }).start();
      return undefined;
    }

    const moveWithKeyboard = (event: KeyboardEvent) => {
      const keyboardHeight = Math.max(0, windowHeight - event.endCoordinates.screenY);
      Animated.timing(footerTranslate, {
        toValue: -Math.max(0, keyboardHeight - insets.bottom),
        duration: event.duration || 250,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    };
    const reset = (event?: KeyboardEvent) => {
      Animated.timing(footerTranslate, {
        toValue: 0,
        duration: event?.duration || 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    };
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow", moveWithKeyboard);
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", reset);
    return () => {
      show.remove();
      hide.remove();
    };
  }, [footerTranslate, insets.bottom, searchFocused, windowHeight]);

  const clearSearch = () => {
    setSearchQuery("");
    searchInputRef.current?.blur();
  };

  const toggleAttentionFilter = () => {
    if (attentionTransitioningRef.current) return;
    attentionTransitioningRef.current = true;
    Keyboard.dismiss();
    searchInputRef.current?.blur();
    Animated.timing(sidebarTransition, {
      toValue: 0,
      duration: 90,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) {
        attentionTransitioningRef.current = false;
        return;
      }

      sidebarScrollRef.current?.scrollTo({ y: 0, animated: false });
      setSearchQuery("");
      setAttentionFilterOpen((open) => !open);

      requestAnimationFrame(() => {
        Animated.timing(sidebarTransition, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start(() => {
          attentionTransitioningRef.current = false;
        });
      });
    });
  };

  const toggleSection = (section: "pinned" | "projects" | "chats") => {
    if (sectionsForcedOpen) return;
    animateSidebarLayout();
    if (section === "pinned") setPinnedSectionExpanded((expanded) => !expanded);
    if (section === "projects") setProjectsSectionExpanded((expanded) => !expanded);
    if (section === "chats") setChatsSectionExpanded((expanded) => !expanded);
  };

  const selectThread = (projectID: string, threadID: string) => {
    const reason = attentionReasons.get(threadID);
    if (attentionFilterOpen && reason) setStickyAttention({ threadID, reason });
    props.onSelect(projectID, threadID);
  };

  return (
    <View style={styles.sidebarSafe}>
      <ScrollView
        ref={sidebarScrollRef}
        style={styles.sidebarThreads}
        contentContainerStyle={[styles.sidebarContent, { paddingTop: insets.top + 68 + HEADER_FADE_HEIGHT, paddingBottom: insets.bottom + SIDEBAR_FOOTER_FADE_HEIGHT }]}
        contentInsetAdjustmentBehavior="never"
        scrollIndicatorInsets={{ top: insets.top + 62, bottom: insets.bottom + 72 }}
      >
        <Animated.View
          style={[
            styles.sidebarContentBody,
            {
              opacity: sidebarTransition,
              transform: [{
                translateY: sidebarTransition.interpolate({ inputRange: [0, 1], outputRange: [-5, 0] }),
              }],
            },
          ]}
        >
        {!attentionFilterOpen ? (
          <DisclosureSection title="Pinned" expanded={pinnedExpanded} onToggle={() => toggleSection("pinned")} disabled={sectionsForcedOpen}>
            {pinnedItems.map(({ project, thread }) => <ThreadRow key={`pin-${thread.id}`} project={project} thread={thread} selected={thread.id === props.selectedThreadID} pinned running={!!props.activeTurnByThread[thread.id]} attentionReason={attentionReasons.get(thread.id) || null} onPress={() => selectThread(project.id, thread.id)} onPin={props.onPin} onRename={props.onRename} onDelete={props.onDelete} />)}
          </DisclosureSection>
        ) : null}
        <DisclosureSection title="Projects" expanded={projectsExpanded} onToggle={() => toggleSection("projects")} disabled={sectionsForcedOpen}>
          {displayedProjectFolders.map((project) => (
            <ProjectSection
              key={project.id}
              title={projectName(project)}
              expanded={sectionsForcedOpen || !collapsedProjectIDs.has(project.id)}
              onToggle={() => {
                if (sectionsForcedOpen) return;
                animateSidebarLayout();
                setCollapsedProjectIDs((current) => {
                  const next = new Set(current);
                  if (next.has(project.id)) next.delete(project.id);
                  else next.add(project.id);
                  return next;
                });
              }}
              onNew={() => props.onNewInProject(project.id)}
            >
              {[...project.threads].sort((a, b) => b.updatedAt - a.updatedAt).map((thread) => <ThreadRow key={thread.id} project={project} thread={thread} selected={thread.id === props.selectedThreadID} pinned={props.pinned.includes(thread.id)} running={!!props.activeTurnByThread[thread.id]} attentionReason={attentionReasons.get(thread.id) || null} onPress={() => selectThread(project.id, thread.id)} onPin={props.onPin} onRename={props.onRename} onDelete={props.onDelete} />)}
            </ProjectSection>
          ))}
          {attentionFilterOpen && attentionDisplay.length === 0 ? (
            <View style={styles.attentionEmpty}>
              <SymbolView name="checkmark.circle" size={28} tintColor={colors.tertiary} />
              <Text style={styles.attentionEmptyTitle}>All caught up</Text>
              <Text style={styles.attentionEmptyBody}>No unread or waiting chats.</Text>
            </View>
          ) : null}
        </DisclosureSection>
        <DisclosureSection title="Chats" expanded={chatsExpanded} onToggle={() => toggleSection("chats")} disabled={sectionsForcedOpen}>
          {[...(displayedChatProject?.threads || [])].sort((a, b) => b.updatedAt - a.updatedAt).map((thread) => <ThreadRow key={thread.id} project={displayedChatProject!} thread={thread} selected={thread.id === props.selectedThreadID} pinned={props.pinned.includes(thread.id)} running={!!props.activeTurnByThread[thread.id]} attentionReason={attentionReasons.get(thread.id) || null} onPress={() => selectThread(CHATS_PROJECT_ID, thread.id)} onPin={props.onPin} onRename={props.onRename} onDelete={props.onDelete} />)}
        </DisclosureSection>
        {noSearchResults ? <Text style={styles.sidebarNoResults}>No chats match “{searchQuery.trim()}”.</Text> : null}
        </Animated.View>
      </ScrollView>
      <View style={[styles.sidebarHeader, { paddingTop: insets.top + 8 }]}>
        <HeaderFade backgroundColor="#0C1016" rgb="12,16,22" />
        <View style={styles.sidebarNavigation}>
          <View style={styles.sidebarBrand}><SymbolView name="bolt.horizontal.fill" size={20} tintColor={colors.accent} /><Text style={styles.sidebarTitle}>Maxx</Text></View>
          <GlassButton
            label={attentionFilterOpen ? "Show all chats" : "Show unread and waiting chats"}
            symbol={attentionFilterOpen ? "bell.fill" : "bell"}
            size={42}
            selected={attentionFilterOpen}
            onPress={toggleAttentionFilter}
          >
            <View style={styles.attentionBellIcon}>
              <SymbolView name={attentionFilterOpen ? "bell.fill" : "bell"} size={19} weight="semibold" tintColor={colors.text} />
              {attentionItems.length > 0 ? <View style={styles.attentionBellDot} /> : null}
            </View>
          </GlassButton>
          <GlassButton label="Return to chat" symbol="chevron.right.2" size={42} onPress={props.onClose} />
        </View>
      </View>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.sidebarFooterFade,
          { height: insets.bottom + SIDEBAR_FOOTER_FADE_HEIGHT, transform: [{ translateY: footerTranslate }] },
        ]}
      >
        <FooterFade backgroundColor="#0C1016" rgb="12,16,22" />
      </Animated.View>
      <Animated.View style={[styles.sidebarFooter, { paddingBottom: insets.bottom + 8, transform: [{ translateY: footerTranslate }] }]}>
        <GlassSurface style={styles.sidebarSearch} fallbackStyle={styles.sidebarSearchFallback}>
          <Pressable style={styles.sidebarSearchPressable} onPress={() => searchInputRef.current?.focus()}>
            <SymbolView name="magnifyingglass" size={18} tintColor={colors.tertiary} />
            <TextInput
              ref={searchInputRef}
              accessibilityLabel="Search chats"
              value={searchQuery}
              onChangeText={setSearchQuery}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search"
              placeholderTextColor={colors.tertiary}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              style={styles.sidebarSearchInput}
            />
          </Pressable>
        </GlassSurface>
        {searchActive ? (
          <GlassButton label="Clear search" symbol="xmark" size={50} onPress={clearSearch} />
        ) : (
          <>
            <GlassButton label="Settings" symbol="gearshape" size={50} onPress={props.onSettings} />
            <GlassButton label="New chat" symbol="square.and.pencil" size={50} onPress={props.onNew} />
          </>
        )}
      </Animated.View>
    </View>
  );
}

function HeaderFade({ backgroundColor, rgb }: { backgroundColor: string; rgb: string }) {
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          experimental_backgroundImage: `linear-gradient(to bottom, ${backgroundColor} 0%, ${backgroundColor} 62%, rgba(${rgb},0.92) 72%, rgba(${rgb},0.48) 88%, rgba(${rgb},0) 100%)`,
        },
      ]}
    />
  );
}

function FooterFade({ backgroundColor, rgb }: { backgroundColor: string; rgb: string }) {
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          experimental_backgroundImage: `linear-gradient(to bottom, rgba(${rgb},0) 0%, rgba(${rgb},0.4) 36%, rgba(${rgb},0.88) 58%, ${backgroundColor} 72%, ${backgroundColor} 100%)`,
        },
      ]}
    />
  );
}

function DisclosureSection({ title, expanded, onToggle, disabled = false, children }: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.sidebarSection}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${title}`}
        accessibilityState={{ expanded, disabled }}
        disabled={disabled}
        onPress={onToggle}
        style={({ pressed }) => [styles.sectionDisclosure, pressed && styles.rowPressed]}
      >
        <Text style={styles.sectionTitle}>{title}</Text>
        <DisclosureChevron expanded={expanded} />
      </Pressable>
      {expanded ? <View style={styles.sectionContent}>{children}</View> : null}
    </View>
  );
}

function DisclosureChevron({ expanded }: { expanded: boolean }) {
  const progress = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: expanded ? 1 : 0,
      duration: 190,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [expanded, progress]);
  const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <SymbolView name="chevron.right" size={11} weight="semibold" tintColor={colors.tertiary} />
    </Animated.View>
  );
}

function ProjectSection({ title, expanded, onToggle, onNew, children }: { title: string; expanded: boolean; onToggle: () => void; onNew: () => void; children: React.ReactNode }) {
  return (
    <View style={styles.sidebarSection}>
      <View style={styles.projectHeader}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${title}`}
          accessibilityState={{ expanded }}
          onPress={onToggle}
          style={({ pressed }) => [styles.projectDisclosure, pressed && styles.rowPressed]}
        >
          <SymbolView
            name={{ ios: expanded ? "folder.fill" : "folder", android: expanded ? "folder_open" : "folder" }}
            size={17}
            tintColor={colors.text}
          />
          <Text numberOfLines={1} style={styles.projectTitle}>{title}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New chat in ${title}`}
          hitSlop={8}
          onPress={onNew}
          style={({ pressed }) => [styles.projectNewChat, pressed && styles.rowPressed]}
        >
          <SymbolView name="square.and.pencil" size={18} weight="semibold" tintColor={colors.secondary} />
        </Pressable>
      </View>
      {expanded ? children : null}
    </View>
  );
}

const THREAD_SPINNER_SIZE = 15;
const THREAD_SPINNER_RADIUS = 5.25;
const THREAD_SPINNER_CIRCUMFERENCE = 2 * Math.PI * THREAD_SPINNER_RADIUS;

function ThreadRunningSpinner({ color }: { color: string }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 850,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [progress]);

  const rotate = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <Animated.View
      accessibilityLabel="Running"
      accessibilityRole="progressbar"
      style={[styles.threadRunning, { transform: [{ rotate }] }]}
    >
      <Svg height={THREAD_SPINNER_SIZE} viewBox="0 0 15 15" width={THREAD_SPINNER_SIZE}>
        <Circle
          cx="7.5"
          cy="7.5"
          fill="none"
          r={THREAD_SPINNER_RADIUS}
          stroke={color}
          strokeOpacity={0.16}
          strokeWidth="1.6"
        />
        <Circle
          cx="7.5"
          cy="7.5"
          fill="none"
          r={THREAD_SPINNER_RADIUS}
          rotation="-90"
          origin="7.5, 7.5"
          stroke={color}
          strokeDasharray={`${THREAD_SPINNER_CIRCUMFERENCE * 0.68} ${THREAD_SPINNER_CIRCUMFERENCE * 0.32}`}
          strokeLinecap="round"
          strokeWidth="1.8"
        />
      </Svg>
    </Animated.View>
  );
}

function ThreadRow({
  project,
  thread,
  selected,
  pinned,
  running,
  attentionReason,
  onPress,
  onPin,
  onRename,
  onDelete,
}: {
  project: ChatProject;
  thread: ChatThread;
  selected: boolean;
  pinned: boolean;
  running: boolean;
  attentionReason: AttentionReason | null;
  onPress: () => void;
  onPin: (id: string) => void;
  onRename: (projectID: string, thread: ChatThread) => void;
  onDelete: (projectID: string, threadID: string) => void;
}) {
  return (
    <MenuView
      shouldOpenOnLongPress
      style={styles.threadMenu}
      actions={threadMenuActions(pinned)}
      onPressAction={(event) => {
        if (event.nativeEvent.event === "pin") onPin(thread.id);
        if (event.nativeEvent.event === "rename") onRename(project.id, thread);
        if (event.nativeEvent.event === "delete") onDelete(project.id, thread.id);
      }}
    >
      <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.threadRow, selected && styles.threadSelected, pressed && styles.rowPressed]}>
        {attentionReason === "waiting" ? (
          <View accessibilityLabel="Waiting for input" style={[styles.threadStatusDot, styles.threadWaitingDot]} />
        ) : running ? (
          <ThreadRunningSpinner color={selected ? colors.text : colors.tertiary} />
        ) : attentionReason ? (
          <View accessibilityLabel="Unread" style={styles.threadStatusDot} />
        ) : (
          <SymbolView name="bubble.left" size={15} tintColor={selected ? colors.text : colors.tertiary} />
        )}
        <View style={styles.threadCopy}>
          <Text numberOfLines={1} style={styles.threadTitle}>{thread.title}</Text>
          <Text numberOfLines={1} style={styles.threadMeta}>{thread.provider} · {thread.model}</Text>
        </View>
      </Pressable>
    </MenuView>
  );
}

const MessageBubble = memo(function MessageBubble({ message: item }: { message: ChatThread["messages"][number] }) {
  const user = item.role === "user";
  const displayContent = user ? item.content : cleanAssistantText(item.content);
  const content = (
    <>
      {item.attachments?.map((attachment) => (
        <MessageAttachment key={attachment.id} attachment={attachment} />
      ))}
      {displayContent ? (
        user ? (
          <Text selectable style={styles.messageText}>{displayContent}</Text>
        ) : (
          <AssistantMarkdown markdown={displayContent} />
        )
      ) : null}
    </>
  );
  return (
    <View style={[styles.messageWrap, user ? styles.userWrap : styles.assistantWrap]}>
      <View style={user ? [styles.bubble, styles.userBubble] : styles.assistantMessage}>{content}</View>
    </View>
  );
});

function MessageAttachment({ attachment }: { attachment: ChatAttachment }) {
  return canPreviewAsNativeImage(attachment.mimeType)
    ? <RemoteAttachmentImage attachment={attachment} />
    : <View style={styles.fileCard}><SymbolView name={attachmentSymbol(attachment.mimeType)} size={18} tintColor={colors.accent} /><Text numberOfLines={1} style={styles.fileName}>{attachment.displayName}</Text></View>;
}

function attachmentSymbol(mimeType: string) {
  if (mimeType.startsWith("image/")) return "photo.fill" as const;
  if (mimeType.startsWith("audio/")) return "waveform" as const;
  if (mimeType.startsWith("video/")) return "video.fill" as const;
  if (mimeType.includes("zip")) return "archivebox.fill" as const;
  return "doc.fill" as const;
}

function ActivityDisclosure({ activity }: { activity: MobileActivity }) {
  const [expanded, setExpanded] = useState(false);
  const rotation = useRef(new Animated.Value(0)).current;
  const presentation = activityPresentation(activity);
  const hasBody = !!(
    presentation.detail
    || presentation.output
    || presentation.files?.length
  );
  const toggle = () => {
    if (!hasBody) return;
    const next = !expanded;
    LayoutAnimation.configureNext({
      duration: 170,
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
    setExpanded(next);
    Animated.timing(rotation, {
      toValue: next ? 1 : 0,
      duration: 150,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };
  return (
    <View style={styles.activityDisclosure}>
      <Pressable
        accessibilityRole={hasBody ? "button" : undefined}
        accessibilityLabel={presentation.verb}
        accessibilityState={hasBody ? { expanded } : undefined}
        disabled={!hasBody}
        onPress={toggle}
        style={({ pressed }) => [styles.activitySummary, pressed && styles.activityPressed]}
      >
        <View style={styles.activityChevronSlot}>
          {hasBody ? (
            <Animated.View style={{ transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] }) }] }}>
              <SymbolView name="chevron.right" size={12} tintColor={colors.tertiary} />
            </Animated.View>
          ) : null}
        </View>
        <Text numberOfLines={1} style={styles.activityVerb}>{presentation.verb}</Text>
        {presentation.title ? <Text numberOfLines={1} style={styles.activityTitle}>{presentation.title}</Text> : null}
        {presentation.state === "running" ? <Text style={styles.activityState}>working</Text> : null}
        {presentation.state === "failed" ? <Text style={styles.activityFailed}>failed</Text> : null}
      </Pressable>
      {expanded ? (
        <View style={styles.activityBody}>
          {presentation.detail ? <Text selectable style={presentation.isReasoning ? styles.activityReasoning : styles.activityCode}>{presentation.detail}</Text> : null}
          {presentation.files?.map((file) => (
            <View key={file.path} style={styles.activityFile}>
              <Text numberOfLines={1} style={styles.activityFilePath}>{file.path}</Text>
              <Text style={styles.activityFileKind}>{file.changeType}</Text>
            </View>
          ))}
          {presentation.output ? <Text selectable style={styles.activityCode}>{presentation.output}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function RemoteAttachmentImage({ attachment }: { attachment: ChatAttachment }) {
  const { client } = useConnection();
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.request<{ mimeType: string; dataBase64: string }>("read_media", { attachmentId: attachment.id })
      .then((content) => {
        if (!cancelled) setSource(`data:${content.mimeType};base64,${content.dataBase64}`);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [attachment.id, client]);
  return source
    ? <Image source={{ uri: source }} style={styles.bubbleImage} resizeMode="cover" />
    : <View style={[styles.bubbleImage, styles.imagePlaceholder]}><SymbolView name="photo" size={24} tintColor={colors.tertiary} /></View>;
}

function LiveBubble({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <View style={[styles.messageWrap, styles.assistantWrap]}>
      <View style={styles.assistantMessage}>
        <Text style={[styles.liveLabel, error && styles.errorLabel]}>
          {error ? "MAXX NEEDS ATTENTION" : "MAXX IS WORKING"}
        </Text>
        {error ? (
          <Text selectable style={styles.messageText}>{text}</Text>
        ) : (
          <StreamingAssistantMarkdown markdown={text} />
        )}
      </View>
    </View>
  );
}

function EmptyTranscript() {
  return <View style={styles.emptyState}><SymbolView name="sparkles" size={44} tintColor={colors.accent} /><Text style={styles.emptyTitle}>What are we building?</Text><Text style={styles.emptyBody}>Send a message, speak, or attach a file. Maxx continues the same chats and projects you use on desktop.</Text></View>;
}

function EmptyChat({ onNew }: { onNew: () => void }) {
  return (
    <View style={styles.emptyState}>
      <SymbolView name="bubble.left.and.bubble.right.fill" size={48} tintColor={colors.accent} />
      <Text style={styles.emptyTitle}>Your Maxx chats, everywhere</Text>
      <Text style={styles.emptyBody}>Create a chat to get started.</Text>
      <GlassPill label="New Chat" symbol="plus" selected style={styles.emptyAction} onPress={onNew} />
    </View>
  );
}

function ActionRow({ symbol, title, subtitle, onPress }: { symbol: Parameters<typeof SymbolView>[0]["name"]; title: string; subtitle: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]} onPress={onPress}><View style={styles.actionIcon}><SymbolView name={symbol} size={22} tintColor={colors.accent} /></View><View style={styles.actionCopy}><Text style={styles.actionTitle}>{title}</Text><Text style={styles.actionSubtitle}>{subtitle}</Text></View><SymbolView name="chevron.right" size={14} tintColor={colors.tertiary} /></Pressable>;
}

function SettingsModal({
  visible,
  hostName,
  address,
  showProviderDiagnostics,
  onShowProviderDiagnosticsChange,
  onClose,
  onReconnect,
  onForget,
}: {
  visible: boolean;
  hostName: string;
  address: string;
  showProviderDiagnostics: boolean;
  onShowProviderDiagnosticsChange: (visible: boolean) => void;
  onClose: () => void;
  onReconnect: () => void;
  onForget: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalPage}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Mobile Settings</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close settings" onPress={onClose}>
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.settingsContent}>
          <Text style={styles.settingsLabel}>CONNECTED MAC</Text>
          <View style={styles.settingsCard}>
            <ActionRow symbol="desktopcomputer" title={hostName} subtitle={address} onPress={onReconnect} />
          </View>
          <Text style={styles.settingsLabel}>CHAT</Text>
          <View style={styles.settingsCard}>
            <View style={styles.settingsPreferenceRow}>
              <View style={styles.settingsPreferenceCopy}>
                <Text style={styles.settingsPreferenceTitle}>Show provider diagnostics</Text>
                <Text style={styles.settingsPreferenceDescription}>
                  Show non-fatal provider notices in chat. Errors and warnings that require action remain visible.
                </Text>
              </View>
              <Switch
                accessibilityLabel="Show provider diagnostics"
                value={showProviderDiagnostics}
                onValueChange={onShowProviderDiagnosticsChange}
                trackColor={{ false: colors.elevatedSoft, true: colors.accentStrong }}
                ios_backgroundColor={colors.elevatedSoft}
              />
            </View>
          </View>
          <Text style={styles.settingsHint}>
            Chats, projects, providers, and voice configuration remain owned by Maxx desktop. This iPhone stores only a revocable device credential and device-local preferences.
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Forget this Mac" style={styles.dangerButton} onPress={onForget}>
            <Text style={styles.dangerText}>Forget This Mac</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function flattenThreads(projects: ChatProject[]) {
  return projects.flatMap((project) => project.threads.map((thread) => ({ project, thread })));
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#050609" },
  main: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, zIndex: 0, isolation: "isolate", backgroundColor: colors.background },
  chatScene: { flex: 1, backgroundColor: colors.background },
  chatHeader: { position: "absolute", left: 0, right: 0, top: 0, zIndex: 20, paddingBottom: HEADER_FADE_HEIGHT, overflow: "hidden" },
  drawer: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, zIndex: 100, isolation: "isolate", backgroundColor: "#0C1016", shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 28, shadowOffset: { width: 10, height: 0 } },
  sidebarSafe: { flex: 1, backgroundColor: "#0C1016" },
  sidebarHeader: { position: "absolute", left: 0, right: 0, top: 0, zIndex: 20, paddingHorizontal: 18, paddingBottom: HEADER_FADE_HEIGHT, overflow: "hidden" },
  sidebarNavigation: { flexDirection: "row", alignItems: "center", gap: 12 },
  sidebarBrand: { flex: 1, flexDirection: "row", alignItems: "center", gap: 9 },
  sidebarTitle: { color: colors.text, fontSize: 24, fontWeight: "800", letterSpacing: -0.5 },
  attentionBellIcon: { width: 42, height: 42, alignItems: "center", justifyContent: "center" },
  attentionBellDot: { position: "absolute", top: 8, right: 8, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent, borderWidth: 1.5, borderColor: "#202631" },
  sidebarThreads: { flex: 1 },
  sidebarContent: { paddingHorizontal: 12 },
  sidebarContentBody: { gap: 18 },
  sidebarFooterFade: { position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 19 },
  sidebarFooter: { position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 20, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingTop: 10 },
  sidebarSearch: { flex: 1, height: 50, borderRadius: 25 },
  sidebarSearchFallback: { backgroundColor: "rgba(32,38,49,0.94)", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong },
  sidebarSearchPressable: { flex: 1, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 16 },
  sidebarSearchInput: { flex: 1, color: colors.text, fontSize: 16, paddingVertical: 0 },
  sidebarNoResults: { color: colors.secondary, fontSize: 14, textAlign: "center", paddingVertical: 26 },
  attentionEmpty: { alignItems: "center", paddingVertical: 54, gap: 7 },
  attentionEmptyTitle: { color: colors.text, fontSize: 17, fontWeight: "700", marginTop: 4 },
  attentionEmptyBody: { color: colors.secondary, fontSize: 13 },
  sidebarSection: { gap: 4 },
  sectionDisclosure: { minHeight: 38, borderRadius: 10, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 7 },
  sectionTitle: { color: colors.secondary, fontSize: 14, fontWeight: "600" },
  sectionContent: { gap: 4 },
  projectHeader: { minHeight: 44, borderRadius: 11, paddingLeft: 10, paddingRight: 4, flexDirection: "row", alignItems: "center" },
  projectDisclosure: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 9 },
  projectTitle: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15, fontWeight: "600" },
  projectNewChat: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20 },
  threadMenu: { width: "100%" },
  threadRow: { minHeight: 54, borderRadius: 13, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 9 },
  threadSelected: { backgroundColor: "rgba(92,139,219,0.22)" },
  rowPressed: { opacity: 0.65 },
  threadStatusDot: { width: 8, height: 8, borderRadius: 4, marginHorizontal: 3.5, backgroundColor: colors.accent },
  threadWaitingDot: { backgroundColor: colors.text, shadowColor: colors.text, shadowOpacity: 0.7, shadowRadius: 4 },
  threadRunning: { width: THREAD_SPINNER_SIZE, height: THREAD_SPINNER_SIZE },
  threadCopy: { flex: 1, minWidth: 0 },
  threadTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  threadMeta: { color: colors.tertiary, fontSize: 11, marginTop: 3, textTransform: "capitalize" },
  sidebarMenuGlyph: { width: 22, height: 15, justifyContent: "center", gap: 6 },
  sidebarMenuGlyphLong: { width: 22, height: 2.5, borderRadius: 2, backgroundColor: colors.text },
  sidebarMenuGlyphShort: { width: 13, height: 2.5, borderRadius: 2, backgroundColor: colors.text },
  topbar: { height: 66, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 12 },
  titleBlock: { flex: 1, minWidth: 0, alignItems: "flex-start" },
  chatTitle: { color: colors.text, fontSize: 16, fontWeight: "700", maxWidth: "100%" },
  chatSubtitle: { color: colors.tertiary, fontSize: 11, textTransform: "capitalize", marginTop: 2, maxWidth: "100%" },
  headerActions: { width: 96, height: 46, borderRadius: 23, flexDirection: "row", alignItems: "center", overflow: "hidden" },
  headerActionMenu: { width: 46, height: 46 },
  headerActionFallback: { backgroundColor: "rgba(32,38,49,0.94)", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong },
  headerActionContent: { width: 46, height: 46, alignItems: "center", justifyContent: "center" },
  headerActionPressed: { opacity: 0.62 },
  headerActionsSpacer: { width: 96 },
  offlineBanner: { backgroundColor: "#8C4A20", minHeight: 34, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  offlineText: { color: colors.text, fontSize: 12, fontWeight: "600" },
  conversation: { flex: 1 },
  transcriptList: { flex: 1 },
  transcript: { paddingHorizontal: 14, gap: 12 },
  transcriptFooter: { gap: 12 },
  composerFooterFade: { position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 17 },
  scrollToBottom: { position: "absolute", left: "50%", marginLeft: -21, zIndex: 18 },
  emptyTranscript: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 24 },
  messageWrap: { width: "100%", flexDirection: "row" },
  userWrap: { justifyContent: "flex-end" },
  assistantWrap: { justifyContent: "flex-start" },
  bubble: { maxWidth: "88%", borderRadius: 21, paddingHorizontal: 15, paddingVertical: 12, gap: 9, overflow: "hidden" },
  userBubble: { backgroundColor: colors.assistantBubble, borderBottomRightRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  assistantMessage: { width: "100%", paddingVertical: 4, gap: 9 },
  messageText: { color: colors.text, fontSize: 16, lineHeight: 23 },
  liveLabel: { color: colors.accent, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  errorLabel: { color: colors.danger },
  activityDisclosure: { width: "100%", paddingHorizontal: 2 },
  activitySummary: { minHeight: 26, flexDirection: "row", alignItems: "center", gap: 6 },
  activityPressed: { opacity: 0.58 },
  activityChevronSlot: { width: 14, alignItems: "center", justifyContent: "center" },
  activityVerb: { color: colors.secondary, fontSize: 12, fontWeight: "600", flexShrink: 0 },
  activityTitle: { color: colors.tertiary, fontSize: 12, flex: 1 },
  activityState: { color: colors.tertiary, fontSize: 10 },
  activityFailed: { color: colors.danger, fontSize: 10, fontWeight: "600" },
  activityBody: { marginLeft: 20, paddingTop: 4, paddingBottom: 5, gap: 6 },
  activityReasoning: { color: colors.tertiary, fontSize: 13, lineHeight: 19 },
  activityCode: { color: colors.secondary, fontSize: 12, lineHeight: 17, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), backgroundColor: colors.elevated, borderRadius: 9, padding: 9 },
  activityFile: { minHeight: 26, flexDirection: "row", alignItems: "center", gap: 8 },
  activityFilePath: { flex: 1, color: colors.secondary, fontSize: 12, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
  activityFileKind: { color: colors.accent, fontSize: 10, textTransform: "lowercase" },
  bubbleImage: { width: 245, height: 180, borderRadius: 13, backgroundColor: colors.elevatedSoft },
  imagePlaceholder: { alignItems: "center", justifyContent: "center" },
  fileCard: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 12, padding: 10, backgroundColor: "rgba(0,0,0,0.18)" },
  fileName: { color: colors.text, fontSize: 13, fontWeight: "600", flexShrink: 1 },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 34, gap: 12 },
  emptyTitle: { color: colors.text, fontSize: 24, fontWeight: "700", textAlign: "center" },
  emptyBody: { color: colors.secondary, fontSize: 15, lineHeight: 22, textAlign: "center", maxWidth: 370 },
  emptyAction: { marginTop: 6 },
  attachmentTray: { paddingHorizontal: 12, paddingVertical: 7, gap: 8 },
  attachmentChip: { maxWidth: 230, height: 36, borderRadius: 12, paddingHorizontal: 10, flexDirection: "row", gap: 7, alignItems: "center", backgroundColor: colors.elevatedSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong },
  attachmentName: { color: colors.text, fontSize: 12, flexShrink: 1 },
  voiceError: { color: colors.danger, fontSize: 11, paddingHorizontal: 18, paddingBottom: 4 },
  voiceStatus: { color: colors.accent, fontSize: 11, fontWeight: "700", paddingHorizontal: 18, paddingBottom: 4 },
  composerOverlay: { position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 20 },
  composerRow: { paddingHorizontal: 10, paddingTop: 7 },
  composer: { width: "100%", minHeight: 92, maxHeight: 196, borderRadius: 25, overflow: "hidden", paddingHorizontal: 4, paddingTop: 4, paddingBottom: 4 },
  composerFallback: { backgroundColor: "rgba(23,28,37,0.94)" },
  composerRecording: { backgroundColor: "rgba(88,31,40,0.94)" },
  composerInput: { minHeight: 42, maxHeight: 135, paddingTop: 10, paddingBottom: 7, paddingHorizontal: 11, color: colors.text, fontSize: 16, lineHeight: 21 },
  composerControls: { width: "100%", minHeight: 42, flexDirection: "row", alignItems: "center", gap: 2 },
  composerControlSpacer: { flex: 1 },
  composerTrailingControls: { marginLeft: "auto", flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 2 },
  inlineButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  attachmentMenu: { width: 40, height: 40 },
  sendButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentStrong, alignItems: "center", justifyContent: "center" },
  stopConversationButton: { backgroundColor: colors.danger },
  sendDisabled: { opacity: 0.35 },
  actionRow: { minHeight: 66, borderRadius: 16, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 9 },
  actionIcon: { width: 43, height: 43, borderRadius: 13, backgroundColor: "rgba(92,139,219,0.16)", alignItems: "center", justifyContent: "center" },
  actionCopy: { flex: 1 },
  actionTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  actionSubtitle: { color: colors.secondary, fontSize: 12, marginTop: 3 },
  modalPage: { flex: 1, backgroundColor: colors.background },
  modalHeader: { height: 58, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  done: { color: colors.accent, fontSize: 16, fontWeight: "600" },
  settingsContent: { padding: 18, gap: 15 },
  settingsLabel: { color: colors.tertiary, fontSize: 11, fontWeight: "800", letterSpacing: 1.2, marginLeft: 8 },
  settingsCard: { borderRadius: 18, backgroundColor: colors.elevated, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, padding: 4 },
  settingsPreferenceRow: { minHeight: 88, flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 14, paddingVertical: 12 },
  settingsPreferenceCopy: { flex: 1, minWidth: 0 },
  settingsPreferenceTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  settingsPreferenceDescription: { color: colors.secondary, fontSize: 12, lineHeight: 17, marginTop: 4 },
  settingsHint: { color: colors.secondary, fontSize: 13, lineHeight: 19, paddingHorizontal: 8 },
  dangerButton: { height: 50, alignItems: "center", justifyContent: "center", borderRadius: 16, backgroundColor: "rgba(255,107,115,0.12)", marginTop: 12 },
  dangerText: { color: colors.danger, fontSize: 16, fontWeight: "600" },
});
