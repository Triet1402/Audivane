import { useEffect, useState } from "react";

import { BrowserTrialPlayer } from "@codec-abx/playback";

import { ListeningController, type ListeningClient, type ListeningState } from "./controller.js";

export interface ListeningHook {
  readonly controller: ListeningController;
  readonly state: ListeningState;
}

interface DiscoveryController {
  refreshOutputDevices(): Promise<void> | void;
}

interface DiscoveryTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface OutputDiscoveryEnvironment {
  readonly window: DiscoveryTarget;
  readonly document: DiscoveryTarget & { readonly visibilityState: string };
}

/**
 * Permission-free output discovery on mount, focus return and visibility
 * return. Devicechange is owned by the player itself. The returned cleanup
 * removes both listeners and is safe to call once.
 */
export function attachOutputDiscovery(
  controller: DiscoveryController,
  environment: OutputDiscoveryEnvironment,
): () => void {
  const discover = (): void => {
    void controller.refreshOutputDevices();
  };
  const onVisibility = (): void => {
    if (environment.document.visibilityState === "visible") discover();
  };
  environment.window.addEventListener("focus", discover);
  environment.document.addEventListener("visibilitychange", onVisibility);
  discover();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    environment.window.removeEventListener("focus", discover);
    environment.document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * One controller per mounted app. The runtime supplies the experiment client
 * (browser Worker or main-owned desktop service); construction stays lazy until
 * an explicit listening preparation command. Playback is the shared Web Audio
 * player in both runtimes.
 */
export function useListening(createClient: () => ListeningClient): ListeningHook {
  const [controller] = useState(
    () => new ListeningController({
      createClient,
      createPlayer: () => new BrowserTrialPlayer(),
    }),
  );
  const [state, setState] = useState<ListeningState>(controller.state);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    const timer = window.setInterval(() => {
      controller.syncPlayback();
    }, 100);
    // Automatic, permission-free output discovery is independent of the
    // disclosure and experiment startup. Devicechange is handled by the
    // player itself; focus/visibility returning covers routes changed while
    // the app was in the background. None of these paths start playback,
    // prepare a test or request microphone/media permission.
    const detachDiscovery = attachOutputDiscovery(controller, { window, document });
    return () => {
      window.clearInterval(timer);
      detachDiscovery();
      unsubscribe();
      void controller.dispose();
    };
  }, [controller]);

  return { controller, state };
}
