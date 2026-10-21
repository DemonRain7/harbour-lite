import {Composition, Folder} from 'remotion';
import {AgentScene, CharacterScene, ClosingScene, HandoffScene, HarbourIntro, OriginalUIScene, WelcomeScene} from './Intro';
import {HarbourStory, STORY_SCENES, storyDurationInFrames} from './Story';

export const RemotionRoot = () => <>
  <Composition id="HarbourIntro" component={HarbourIntro} durationInFrames={900} fps={30} width={1920} height={1080} />
  <Folder name="Scenes">
    <Composition id="Welcome" component={WelcomeScene} durationInFrames={135} fps={30} width={1920} height={1080} />
    <Composition id="OriginalUI" component={OriginalUIScene} durationInFrames={165} fps={30} width={1920} height={1080} />
    <Composition id="OwnAgent" component={AgentScene} durationInFrames={165} fps={30} width={1920} height={1080} />
    <Composition id="Character" component={CharacterScene} durationInFrames={165} fps={30} width={1920} height={1080} />
    <Composition id="AgentHandoff" component={HandoffScene} durationInFrames={195} fps={30} width={1920} height={1080} />
    <Composition id="Closing" component={ClosingScene} durationInFrames={150} fps={30} width={1920} height={1080} />
  </Folder>
  {/* 双语长版介绍片（放映室主题），约 39 秒，剪辑踩 120 BPM；短版 HarbourIntro 保持不变。 */}
  <Composition id="HarbourStory" component={HarbourStory} durationInFrames={storyDurationInFrames(30)} fps={30} width={1920} height={1080} />
  <Folder name="StoryScenes">
    {STORY_SCENES.map(({seconds, component}, i) => (
      <Composition key={i} id={`Story${String(i).padStart(2, '0')}`} component={component} durationInFrames={seconds * 30} fps={30} width={1920} height={1080} />
    ))}
  </Folder>
</>;
