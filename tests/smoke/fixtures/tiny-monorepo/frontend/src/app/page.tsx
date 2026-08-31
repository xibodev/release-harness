import Button from "../components/Button";

export default function Home() {
  return (
    <main>
      <h1>tinyapp</h1>
      <p>synthetic Next.js page for bundle smoke tests</p>
      <Button onClick={() => alert("hi")} />
    </main>
  );
}
