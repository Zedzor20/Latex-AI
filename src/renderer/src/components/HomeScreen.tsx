import { Bug, Code2, Rocket, SearchCheck } from "lucide-react";
import logo from "../assets/latex-logo.svg";

const quickActions = [
  {
    icon: Code2,
    title: "Explore and understand code",
    description: "Inspect a project and explain how it works.",
    prompt: "Inspect this project and explain how it works."
  },
  {
    icon: Rocket,
    title: "Build a new feature",
    description: "Create a feature, app, or tool.",
    prompt: "Build a new feature in this workspace."
  },
  {
    icon: SearchCheck,
    title: "Review code",
    description: "Analyze code and suggest improvements.",
    prompt: "Review this code for problems and improvements."
  },
  {
    icon: Bug,
    title: "Fix an issue",
    description: "Debug errors and fix problems.",
    prompt: "Fix the issue in this project."
  }
];

export function HomeScreen({ onStartPrompt }: { onStartPrompt: (prompt: string) => void }) {
  return (
    <div className="home">
      <img src={logo} className="homeLogoImg" alt="Latex logo" />
      <h1 className="homeTitle">
        What should we work on in <span>Latex</span>?
      </h1>
      <p className="homeSubtitle">Inspect a project, build something new, review code, or fix an issue.</p>
      <div className="quickGrid">
        {quickActions.map(({ icon: Icon, title, description, prompt }) => (
          <button key={title} type="button" className="quickCard" onClick={() => onStartPrompt(prompt)}>
            <Icon size={18} className="quickIcon" />
            <span className="quickText">
              <strong>{title}</strong>
              <span>{description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
