import {Composition, Folder} from 'remotion';
import {AgentScene, CharacterScene, ClosingScene, DataScene, HarbourIntro, ModelScene, WelcomeScene} from './Intro';

export const RemotionRoot = () => <>
  <Composition id="HarbourIntro" component={HarbourIntro} durationInFrames={900} fps={30} width={1920} height={1080} />
  <Folder name="Scenes">
    <Composition id="Welcome" component={WelcomeScene} durationInFrames={135} fps={30} width={1920} height={1080} />
    <Composition id="Connect" component={ModelScene} durationInFrames={165} fps={30} width={1920} height={1080} />
    <Composition id="Agent" component={AgentScene} durationInFrames={165} fps={30} width={1920} height={1080} />
    <Composition id="Character" component={CharacterScene} durationInFrames={165} fps={30} width={1920} height={1080} />
    <Composition id="LocalData" component={DataScene} durationInFrames={195} fps={30} width={1920} height={1080} />
    <Composition id="Closing" component={ClosingScene} durationInFrames={150} fps={30} width={1920} height={1080} />
  </Folder>
</>;
