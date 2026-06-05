package deploy

import (
	"fmt"
	"log"
	"os/exec"
)

type Deployer struct{}

func New() *Deployer {
	return &Deployer{}
}

func (d *Deployer) Deploy(gitURL, branch, appName string, port int) error {
	log.Printf("deploying %s from %s (branch=%s, port=%d)", appName, gitURL, branch, port)

	if err := d.cloneOrPull(gitURL, branch, appName); err != nil {
		return fmt.Errorf("clone/pull failed: %w", err)
	}

	if err := d.build(appName); err != nil {
		return fmt.Errorf("build failed: %w", err)
	}

	if err := d.healthCheck(appName, port); err != nil {
		log.Printf("health check failed, rolling back: %v", err)
		return d.Rollback(appName)
	}

	log.Printf("deployment of %s successful", appName)
	return nil
}

func (d *Deployer) Rollback(appName string) error {
	log.Printf("rolling back %s", appName)
	return nil
}

func (d *Deployer) cloneOrPull(gitURL, branch, appName string) error {
	dir := fmt.Sprintf("/opt/kryptalis/apps/%s", appName)
	cmd := exec.Command("git", "clone", "--branch", branch, "--depth", "1", gitURL, dir)
	return cmd.Run()
}

func (d *Deployer) build(appName string) error {
	dir := fmt.Sprintf("/opt/kryptalis/apps/%s", appName)
	cmd := exec.Command("docker", "build", "-t", fmt.Sprintf("kryptalis/%s:latest", appName), dir)
	return cmd.Run()
}

func (d *Deployer) healthCheck(_ string, _ int) error {
	return nil
}
